# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Meetey** is a local-first meeting capture and summarization tool that runs entirely within Claude Code. It captures audio from running meeting apps (Google Meet, Zoom, Microsoft Teams) using macOS ScreenCaptureKit, transcribes locally with whisper.cpp, and produces structured summaries via Claude. Optionally it also captures screen keyframes with on-device OCR.

Recording, transcription, and OCR are all local; no third-party meeting service is involved. The summary itself is written by Claude, so transcript and OCR **text** does go to the API — keep that distinction accurate in docs and user-facing copy.

## Setup

```bash
npx jej2k5/meetey install
```

This builds the Swift binary, downloads the Whisper model, copies the MCP server and skill to `~/.meetey/`, registers the MCP server in `~/.claude.json`, and adds hotkeys.

## Commands

| Command | Purpose |
|---|---|
| `npx jej2k5/meetey install` | First-time setup (or `node cli/index.js install` from a local clone) |
| `npx jej2k5/meetey update` | Rebuild binary, refresh MCP server and skill |
| `npx jej2k5/meetey status` | Show what's installed and whether everything is wired up |
| `swift build -c release` | Rebuild the Swift capture binary (run inside `meetey-capture/`) |
| `node mcp-server/index.js` | Run the MCP server manually for debugging |
| `codesign --force --sign - --options runtime --entitlements entitlements.plist .build/release/meetey-capture` | Re-sign after a Swift rebuild (run inside `meetey-capture/`) |

## Architecture

```
User → /meetey (skill) → MCP server (Node.js) → meetey-capture (Swift CLI)
                                              → whisper-cli
```

**`meetey-capture/`** — Swift CLI using ScreenCaptureKit. Takes `--app <bundle-id>` and `--output <path.wav>`, records app audio as 16-bit PCM WAV at 16 kHz mono, stops on SIGTERM/SIGINT or after `--stop-after <seconds>` of wall-clock time. Also supports `--list-apps` (prints running supported apps as JSON), `--selftest` (exercises the keyframe pipeline with synthetic frames, no permission needed), and the `--video` flags below. Requires macOS 13+.

**`mcp-server/index.js`** — Node.js MCP server. Manages the capture process lifecycle and shells out to `whisper-cli` for transcription. Exposes six tools: `list_apps`, `start_recording`, `stop_recording`, `transcribe`, `get_keyframes`, `get_status`. Registered globally in `~/.claude.json` by the installer.

**`mcp-server/quality.js`** — Deterministic transcript assessment, kept out of `index.js` so it stays unit-testable. `wavDurationMs()` reads the exact length from the WAV header rather than subtracting wall-clock start/stop (which includes process spin-up and the SIGTERM drain). `assessQuality()` grades a transcript `good`/`fair`/`poor`/`unusable` from fragment rate, whisper looping, and speech pace measured against *spoken* time — so a quiet meeting isn't penalised for its silences. Each segment counts toward `degradedRatio` at most once; summing the categories independently lets the ratio exceed 1.0.

**`skill/SKILL.md`** — The `/meetey` slash command, with `start`, `stop`, and `status` subcommands. `start` drives `list_apps → start_recording`; `stop` drives `stop_recording → transcribe → get_keyframes` and writes two files; `status` calls `get_status`.

## Notes Output

The notes are the product, so the template is load-bearing. Four rules it exists to enforce:

- **Every claim carries its timestamp.** Decisions, action items, and screen notes all render `[mm:ss]` (`[h:mm:ss]` past the hour) derived from segment `fromMs` or frame `offsetMs`. Without this a reader who doubts one line has to search thousands of words of raw ASR, which is the thing the summary exists to replace.
- **The transcript is a sibling file, never inline and never printed to chat.** An hour of speech is ~9,000 unattributed words; at equal heading weight it buries the two action items someone actually came back for.
- **Empty states diagnose.** "No decisions recorded" is true both when a meeting made none and when transcription was too poor to find them, and only the second is actionable. Branch the copy on `quality.level`.
- **Filenames are browsable.** `YYYY-MM-DD-HHMM-<slug>.md`, with YAML front matter linking back to the session, WAV, and frames. Epoch-stamped names are ungreppable.

Design rationale and the critique that produced these: `.impeccable/critique/`.

**`docs/video-capture-plan.md`** — Design rationale for screen capture. Read before changing the keyframe pipeline.

**`cli/`** — The `meetey` CLI (`bin` entry in `package.json`). `index.js` dispatches to `commands/install.js`, `commands/update.js`, and `commands/status.js`; `paths.js` holds every install path in one place. `install` checks the macOS version, installs whisper-cpp via Homebrew, downloads `ggml-base.en.bin`, builds and code-signs the Swift binary, installs the MCP server and skill, and adds hotkeys.

## Supported App Bundle IDs

| App | Bundle ID |
|---|---|
| Chrome (Google Meet / Teams web) | `com.google.Chrome` |
| Zoom | `us.zoom.xos` |
| Microsoft Teams (desktop) | `com.microsoft.teams` |

## Screen Capture

Off by default, opt-in **per recording**. There is deliberately no env var, config key, or persisted preference that enables it — `start_recording` requires `captureVideo: true` on every call, and the skill must ask the user each time. Do not add a "remember this choice" affordance.

Rather than recording video, the capture binary samples at `--fps` (default 1) and writes a JPEG only when the screen changes materially. Design notes:

- **Scene detection is a 32×32 luma grid with a changed-cell count**, not a perceptual hash. dHash was tried first and fails on exactly the content that matters: downsampling a slide to 8×8 averages a headline change into nothing, so "Agenda" → "Budget" reads as an unchanged screen. `--scene-threshold` is the number of cells (out of 1024) that must move; `cellDelta` (24) is the per-cell luma delta that counts as movement.
- **Two queues.** Grid comparison runs on the capture callback; JPEG encoding and OCR run on a separate serial queue. Blocking the callback makes ScreenCaptureKit drop frames.
- **Only `.complete` frames count.** SCKit delivers idle/blank/suspended frames; hashing those produces spurious keyframes on a static screen.
- **`showsCursor = false`** — a moving cursor otherwise changes the grid and emits keyframes on an unchanged screen.
- **Capture at pixel dimensions, not points.** `SCDisplay.width/height` are points; use `CGDisplayCopyDisplayMode().pixelWidth`. Capturing at point dimensions on a Retina display halves resolution and makes OCR unusable.
- OCR runs on the native-resolution buffer via `VNRecognizeTextRequest`; the persisted JPEG is downscaled to a 2576px long edge.

Artifacts land in `~/.meetey/recordings/<session>-frames/` with an `index.json` manifest (`file`, `offsetMs`, `fingerprint`, `ocrText`). They are never auto-deleted — the notes reference them.

## Known Limitations

ScreenCaptureKit captures at the **process level**, not the tab level. When targeting Chrome, all Chrome audio is captured — not just the meeting tab. Users should mute other tabs playing audio before starting a recording. With screen capture on, the same applies visually: other tabs, other windows of that app, and notification banners are all in frame.

**Camera-heavy calls burn the frame budget.** A moving video tile changes the grid continuously, so keyframes fire every debounce interval (2s) until `--max-frames` is hit. Screen capture is for slides and screen shares; audio-only is the right choice for faces-only discussions.

## Model

Default: `ggml-base.en.bin` (~142 MB) stored at `~/.meetey/models/`. Override with `MEETEY_MODEL` env var. Larger models (`small.en`, `large-v3-turbo-q5_0`) give better accuracy — download the model to `~/.meetey/models/` and update `MEETEY_MODEL` in the `mcpServers.meetey.env` section of `~/.claude.json` to switch.

## Hotkeys

- `Ctrl+Shift+R` — `/meetey start`
- `Ctrl+Shift+S` — `/meetey stop`

## License

Apache 2.0. Every source file carries the standard Apache header — add it to any
new `.js` or `.swift` file. `LICENSE` is the verbatim Apache text and should not
be edited; copyright and third-party attributions live in `NOTICE`.

Never commit recordings, transcripts, or `.claude/settings.local.json` — see
`.gitignore`.
