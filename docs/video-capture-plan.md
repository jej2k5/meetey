# Implementation Plan: Visual Capture

Status: **implemented** — all six phases landed. See "What changed during
implementation" at the bottom for where the shipped design diverges from this
plan.
Target: `meetey` v1.1.0

## Goal

Capture the visual content of a meeting — slides, screen shares, code, diagrams —
and fold it into the summary alongside the audio transcript.

## Non-goals

- **Recording a watchable video file.** Meetey is a summarizer, not a DVR. See
  "Why keyframes, not video" below.
- **Anything involving faces.** Gallery-view thumbnails add nothing to a summary,
  and reading expressions or body language is out of scope permanently.
- **Speaker identification from video.** Separate problem, separate design.

## Why keyframes, not video

Claude has no video input — image input is JPEG/PNG/GIF/WebP, documents are PDF.
Any "summarize the video" feature is really "summarize N sampled frames," so N is
the entire design problem.

At 1 fps, a 60-minute meeting is 3,600 frames. One 16:9 frame at 1568×882 costs
roughly `(1568 × 882) / 750` ≈ 1,844 tokens, so the naive path is ~6.6M tokens —
past the 1M context window and ~$33/meeting at Opus 5 input pricing.

A real meeting has 20–60 *distinct* visual states. Everything between them is
identical pixels.

| Approach | Frames/hr | Tokens | Input cost |
|---|---|---|---|
| Naive 1 fps | 3,600 | 6.6M | ~$33 — exceeds context |
| Scene-change keyframes | ~40 | ~74K | ~$0.37 |
| Keyframes → local OCR → text | ~40 | ~5K | ~$0.03 |
| *(audio transcript today)* | — | ~12K | *~$0.06* |

Once deduplication is mandatory, encoding an H.264 file is pointless work. We
capture at a low frame rate, hash each frame, and persist a JPEG **only when the
scene materially changes**. This drops `AVAssetWriter` entirely and takes storage
from ~100–400 MB/hr of video to ~10 MB/hr of keyframes (the existing audio is
115 MB/hr at 16 kHz × 16-bit × mono).

OCR runs locally via the macOS Vision framework, so the *extraction* stays on the
machine and only text leaves. Keyframe images remain on disk as an escalation
path — Claude Code's Read tool renders images natively, so the skill can read a
specific frame when OCR is insufficient (whiteboards, diagrams, charts).

## What already exists

`meetey-capture` is **already running a video stream** and discarding the frames:

```swift
config.capturesAudio = true
config.width  = 2      // dummy — SCStream requires video dimensions
config.height = 2      // even for audio-only capture
```

`addStreamOutput` registers only `.audio`, and `CaptureDelegate` early-returns on
`guard type == .audio`.

`entitlements.plist` already declares `com.apple.security.screen-capture` — the
*screen* entitlement. **No new permission, no new TCC prompt, no re-onboarding**
for users who already granted Screen Recording.

## Artifacts per session

```
~/.meetey/recordings/
  meetey-1234.wav                 # unchanged
  meetey-1234-frames/
    0001-000000.jpg               # <seq>-<offset_ms>.jpg
    0002-047500.jpg
    index.json
```

`index.json`:

```json
{
  "sessionId": "meetey-1234",
  "startedAt": "2026-08-01T14:02:11Z",
  "frameCount": 2,
  "truncated": false,
  "frames": [
    { "file": "0001-000000.jpg", "offsetMs": 0, "phash": "a3f1...", "ocrText": "Q3 Roadmap" }
  ]
}
```

`truncated` is set when the per-session keyframe cap is hit, so the skill can say
so rather than silently summarizing a partial record.

---

## Phase 0 — Flags and plumbing

No behavior change. Establishes the surface so later phases are additive.

- `Args`: add `--video`, `--fps <n>` (default 1), `--frames-dir <path>`,
  `--no-ocr`, `--scene-threshold <n>` (default 10), `--max-frames <n>` (default 200).
- Update the usage string.
- Video stays off unless `--video` is passed.

**Verify:** existing audio-only invocation is byte-identical in behavior;
`--help` lists new flags.

## Phase 1 — Keyframe capture (Swift)

The load-bearing phase. Testable standalone, no MCP or skill changes needed.

1. **Stream config**, only when `--video`:
   - `config.width/height` from `SCDisplay`, multiplied by the backing scale
     factor (see Risks — points vs. pixels is the easiest thing to get wrong here,
     and getting it wrong makes OCR illegible).
   - `config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(fps))`
   - `config.pixelFormat = kCVPixelFormatType_32BGRA`
   - `config.queueDepth = 5`, `config.showsCursor = false`
2. `stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue:)` on a
   **separate** queue from audio.
3. **Frame status check.** ScreenCaptureKit delivers frames with a
   `SCStreamFrameInfoStatus` attachment — skip anything that isn't `.complete`.
   Idle/blank/suspended frames are common and will otherwise pollute the hash
   comparison. This is the single most-missed detail in SCKit video code.
4. **Two-stage pipeline**, to avoid dropping frames:
   - *On the sample queue (fast):* downscale to 64×64 grayscale, compute a 64-bit
     dHash, compare Hamming distance against the last accepted keyframe. Discard
     and return if under threshold.
   - *On a separate serial queue (slow):* JPEG-encode at full resolution, write
     to disk, append to the in-memory index.
5. **Debounce:** minimum 2s between accepted keyframes, so slide transitions and
   scroll animations don't emit a burst of near-identical frames.
6. **Cap:** stop accepting keyframes at `--max-frames`, set `truncated: true`.
7. On stop, write `index.json` alongside the WAV finalization.

**Verify:** run the binary directly against Chrome with a slide deck; confirm one
keyframe per slide, no duplicates, no frames during idle talking. Confirm audio
output is unchanged (regression — this is the phase most likely to break it).

## Phase 2 — Local OCR

- `VNRecognizeTextRequest` with `.accurate`, run on the full-resolution buffer on
  the slow queue, before JPEG encoding.
- Join recognized strings top-to-bottom, store in `index.json` as `ocrText`.
- `--no-ocr` skips it.

**Verify:** OCR text from a slide deck is legible and roughly complete. Confirm
the OCR pass doesn't stall the capture queue on a busy meeting.

## Phase 3 — MCP server

- `start_recording` gains `captureVideo` (boolean, default **false**), `fps`.
- `stop_recording` returns `framesDir`, `keyframeCount`, `truncated`.
- New tool `get_keyframes` → parsed `index.json` (paths, offsets, OCR text).
- **Extend `transcribe` to return timestamped segments.** Currently it flattens
  whisper's JSON to a single joined string and throws the offsets away — the
  timeline merge in Phase 4 needs them. Keep the joined `transcript` field for
  backward compatibility and add a `segments` array.

**Verify:** drive the four tools by hand via `node mcp-server/index.js`.

## Phase 4 — Skill

- `/meetey start` asks whether to capture screen content, defaulting to **no**;
  `/meetey start --video` skips the prompt.
- Before starting with video, warn explicitly (see Privacy).
- On `/meetey stop`: `stop_recording` → `transcribe` → `get_keyframes`, then merge
  keyframes into the transcript timeline by offset.
- Escalation: when a frame's `ocrText` is thin or the surrounding transcript
  suggests a diagram/chart, Read the JPEG directly rather than relying on OCR.
- Output gains a **Screen Content** section; the existing Summary / Key Decisions /
  Action Items sections should now draw on both sources.
- If `truncated`, say so in the output.

**Verify:** end-to-end on a real meeting with a screen share.

## Phase 5 — Docs

- `README.md`: document `--video`, the opt-in default, and the honest data-flow
  statement (below).
- `CLAUDE.md`: new artifacts, new tools, the frames directory layout.
- `.gitignore`: `*-frames/` (recordings are already ignored, but be explicit).

---

## Privacy

This is the part that needs a decision before code, not after.

**The process-level capture limitation gets materially worse.** For audio,
capturing all of Chrome means catching a YouTube tab. For video it means
capturing whatever Chrome *displays* — other tabs, the bookmarks bar, a password
manager, a Slack DM that pops up. A screen share can contain API keys, customer
PII, or a colleague's private dashboard.

`SCContentFilter(display:including:[app])` does bound this — other applications'
windows stay out of frame — but everything the target app shows is captured.

Rules this plan commits to:

1. **Opt-in per recording.** Never a default, never a persisted preference.
2. **Explicit warning before the first frame**, naming the app: *"This will
   capture everything Chrome displays, including other tabs and notifications."*
3. **Extraction stays local.** OCR runs on-device; the default path sends only
   text. Images are sent only on explicit escalation.
4. **Correct the data-flow claim in the README.** It currently reads "no data
   leaves your machine," which is already imprecise — audio never leaves, but the
   transcript goes to the API to be summarized. Adding screen content changes the
   character of what's transmitted, not just the volume. The README should say
   plainly what stays local (audio, video, OCR) and what leaves (text, and images
   only on request).

## Risks

| Risk | Mitigation |
|---|---|
| Points vs. pixels on Retina — undersized capture makes OCR illegible | Multiply `SCDisplay` dimensions by backing scale factor; verify OCR on a 4K display before shipping |
| Frame drops if the handler is slow | Hash on the sample queue, JPEG+OCR on a separate serial queue; never block the callback |
| Idle/blank frames polluting dedup | Check `SCStreamFrameInfoStatus`, accept only `.complete` |
| Memory growth from retained `CVPixelBuffer`s | Never retain past the handler; copy what's needed |
| Scene threshold poorly tuned → too many or too few frames | `--scene-threshold` flag; tune against real meetings in Phase 1 |
| Cost blowout on a long meeting | `--max-frames` cap + `truncated` surfaced in output |
| Audio regression from the config change | Explicit regression check in Phase 1 verification |

There is no test framework in this repo today, so every phase above specifies
manual verification. Adding one is out of scope here but worth its own issue.

## Effort

| Phase | Estimate |
|---|---|
| 0 — Flags | ~1h |
| 1 — Keyframe capture | ~4–6h (the fiddly one: `CVPixelBuffer`, `CIContext`, queues) |
| 2 — OCR | ~1–2h |
| 3 — MCP | ~2h (the `transcribe` segment change is the real work) |
| 4 — Skill | ~3h (timeline merge is the main design work; likely to need iteration) |
| 5 — Docs | ~1h |

Roughly **1.5–2 days** for a solid v1.

## Resolved questions

1. **`--fps` default: 1.** Lowering it to 0.5 saves nothing meaningful — grid
   comparison is microseconds and dedup governs cost — while risking a missed
   slide on a fast flip.
2. **`--max-frames` default: 200.** Kept. It only binds on pathological input
   (a video tile changing continuously), which is exactly when a cap is wanted.
3. **Keyframes are kept, not auto-deleted.** Reversed from the original
   inclination. The notes reference specific frames, so deleting them makes the
   summary unverifiable, and skill-driven deletion is unreliable. The skill tells
   the user where they are and that they can be removed.
4. **Default path sends OCR text only.** Images go to Claude solely on
   escalation — diagrams, charts, garbled OCR. Cheapest and most private.

## What changed during implementation

**Scene detection is not a perceptual hash.** The plan specified a 64-bit dHash
at 9×8. It was implemented, and the self-test immediately caught it failing on
the central case: two slides differing only in their headline text hashed
almost identically (`0000000103000000`), so `AGENDA` → `BUDGET` registered as an
unchanged screen. Downsampling a 1280×720 slide to 72 cells averages a text
change into nothing.

Replaced with a **32×32 luma grid and a changed-cell count**: a cell counts as
changed when its luma moves by more than 24 (of 255), and the scene counts as
changed when at least `--scene-threshold` cells (default 12 of 1024) move. This
matches how screen content actually changes — in localized regions rather than
globally. The manifest's `phash` field became `fingerprint`, an FNV-1a hash of
the grid, useful only for identity and threshold tuning.

**Added `--selftest`.** Not in the original plan. Screen Recording permission
wasn't available in the build environment, so the keyframe pipeline was
otherwise unverifiable. It drives the real `KeyframeWriter` with synthetic
frames and asserts on dedup behaviour, JPEG output, OCR recovery, and manifest
shape. It is what caught the dHash failure.

---

## Revision: the accept rule

The original rule — *differs from the last keyframe → write it* — turned out to
be the wrong shape, in a way `--max-frames` masked rather than solved.

**The frame budget was being exhausted, not spent.** In the standard
slide-plus-speaker-tile layout the tile always exceeded the threshold, so the 2s
debounce was the only throttle: 200 files landed in the first ~7 minutes and the
remaining 50 were recorded as `truncated`. The "camera-heavy calls burn the frame
budget" caveat in CLAUDE.md described this as inherent. It was not.

Four changes, all in `KeyframeWriter`:

1. **Capture on settle, not on change.** A detected change becomes a *pending*
   candidate, persisted only once a later sample shows the screen has come to
   rest. A transition collapses to one file, and it is the settled frame — which
   also OCRs far better than anything caught mid-fade. `--max-unsettled`
   (default 60s) forces a capture on a screen that never rests, and `finalize()`
   flushes a candidate still pending when the meeting ends.
2. **Mask cells that are always moving.** A rolling 15-sample window marks a cell
   volatile at ≥60% and releases it below 30%; volatile cells don't count toward
   the threshold. The hysteresis is not optional — with a single cutoff, cells
   straddling a moving region's edge flicker in and out of the mask and leak ~15
   cells per sample, which clears the threshold of 12 on its own. Neither is the
   one-cell dilation: the grid averages ~40×22px per cell, so a tile's boundary
   lands mid-cell and moves less than its interior.
3. **Dedup against every keyframe, not just the previous one.** A deck navigated
   4 → 5 → 4 wrote slide 4 twice. Matches now append to `revisitsMs` on the
   existing record instead of writing a second copy — fewer files *and* a richer
   timeline. `fingerprint` remains identity-only and is still not used for this.
4. **`--display` / `--window`.** The default display is now the one showing the
   target app rather than `displays.first`; on a multi-monitor setup those are
   frequently different, which made screen capture record the wrong screen
   entirely. `--window` scopes to one window, excluding the app's other windows
   and its notification banners from both the frame and the detector.

**Two interactions are load-bearing and both were found by the selftest, not by
reasoning.** A full-screen video makes *every* cell volatile, so (a) the masked
delta reads as zero and the `--max-unsettled` valve never fires unless it checks
the *unmasked* delta, and (b) a masked identity comparison reports every frame as
a revisit of the first — so revisit matching is skipped when less than a quarter
of the grid is unmasked. Change either rule without the corresponding guard and a
video demo records one frame for an entire hour, silently.

`--no-volatility-mask` disables (2) as an escape hatch. `MEETEY_DEBUG_KEYFRAMES=1`
prints the per-sample decision trace that made all of this tractable.
