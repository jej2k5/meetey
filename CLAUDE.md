# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Meetey** is a local-first meeting capture and summarization tool that runs entirely within Claude Code. It captures audio from running meeting apps (Google Meet, Zoom, Microsoft Teams) using macOS ScreenCaptureKit, transcribes locally with whisper.cpp, and produces structured summaries via Claude. Optionally it also captures screen keyframes with on-device OCR.

Recording, transcription, and OCR are all local; no third-party meeting service is involved. The summary itself is written by Claude, so transcript and OCR **text** does go to the API — keep that distinction accurate in docs and user-facing copy.

## Setup

```bash
npx jej2k5/meetey install
```

This builds the Swift binary, downloads the Whisper model, copies the MCP server and skill to `~/.meetey/`, registers the MCP server in `~/.claude.json`, and adds Claude Code shortcuts.

## Commands

| Command | Purpose |
|---|---|
| `npx jej2k5/meetey install` | First-time setup (or `node cli/index.js install` from a local clone) |
| `npx jej2k5/meetey update` | Rebuild binary, refresh MCP server and skill |
| `npx jej2k5/meetey status` | Show what's installed and whether everything is wired up |
| `npx jej2k5/meetey watch enable\|disable\|status\|logs` | Control the meeting watcher (also `/meetey watch` from Claude Code) |
| `swift build -c release` | Rebuild the Swift capture binary (run inside `meetey-capture/`) |
| `.build/release/meetey-capture --selftest` | Keyframe pipeline + auto-stop, no permission needed |
| `node daemon/watch.js --selftest` | Meeting-detection patterns |
| `node mcp-server/index.js` | Run the MCP server manually for debugging |
| `codesign --force --sign - --options runtime --entitlements entitlements.plist .build/release/meetey-capture` | Re-sign after a Swift rebuild (run inside `meetey-capture/`) |

## Architecture

```
User → /meetey (skill) → MCP server (Node.js) → meetey-capture (Swift CLI)
                                              → whisper-cli
```

**`meetey-capture/`** — Swift CLI using ScreenCaptureKit. Takes `--app <bundle-id>` and `--output <path.wav>`, records app audio as 16-bit PCM WAV at 16 kHz mono, stops on SIGTERM/SIGINT, after `--stop-after <seconds>` of wall-clock time, or via `--auto-stop`. Also supports `--list-apps` (prints running supported apps as JSON), `--selftest` (exercises the keyframe pipeline with synthetic frames, no permission needed), and the `--video` flags below. Requires macOS 13+.

**`mcp-server/index.js`** — Node.js MCP server. Manages the capture process lifecycle and shells out to `whisper-cli` for transcription. Registered globally in `~/.claude.json` by the installer. Seventeen tools in three groups:

| Capture | Admin | Watcher |
|---|---|---|
| `list_apps` | `list_recordings` | `watcher_status` |
| `list_displays` | `get_recording` | `enable_watcher` |
| `list_windows` | `search_recordings` | `disable_watcher` |
| `start_recording` | `delete_recording` | `watcher_log` |
| `stop_recording` | `system_status` | |
| `transcribe` | | |
| `get_keyframes` | | |
| `get_status` | | |

**`mcp-server/library.js`** — The admin surface: reads the recordings directory and answers questions about it. Kept separate from `index.js` so it stays testable, and it never writes anything except through `deleteRecording`.

Joining the library is the non-obvious part. Three independently-named things have to be reconciled: WAVs and frame directories keyed by session id, and markdown that points back at a session. Notes carry `session:` in front matter; **transcripts are matched by filename convention** (`<notes-stem>-transcript.md`) rather than requiring their own front matter — an early version required it and silently dropped transcripts from search. Pre-1.1.0 notes sharing the WAV stem are also matched, and a transcript whose notes file is gone is surfaced as an orphan rather than disappearing.

`deleteRecording` is dry-run by default and only acts on `confirm: true`, so the caller has to have seen the file list first.

**`mcp-server/quality.js`** — Deterministic transcript assessment, kept out of `index.js` so it stays unit-testable. `wavDurationMs()` reads the exact length from the WAV header rather than subtracting wall-clock start/stop (which includes process spin-up and the SIGTERM drain). `assessQuality()` grades a transcript `good`/`fair`/`poor`/`unusable` from fragment rate, whisper looping, and speech pace measured against *spoken* time — so a quiet meeting isn't penalised for its silences. Each segment counts toward `degradedRatio` at most once; summing the categories independently lets the ratio exceed 1.0.

**`skill/SKILL.md`** — The `/meetey` slash command. Capture subcommands: `start` drives `list_apps → start_recording`; `stop` drives `stop_recording → transcribe → get_keyframes` and writes two files; `status` calls `get_status`. Library subcommands map one-to-one onto the admin tools — `list`, `show`, `search`, `delete`, `doctor` for `list_recordings`, `get_recording`, `search_recordings`, `delete_recording`, `system_status`.

The admin tools were reachable by natural language from the start; the subcommands exist because that made them undiscoverable — nothing in the skill menu revealed the library existed. Both routes are supported and neither is the canonical one, so don't redirect a user from one to the other. `system_status` is `doctor` rather than anything containing "status" because `/meetey status` already means "is a recording running".

## The watch agent

**`daemon/watch.js`** — a launchd LaunchAgent that notices meetings and *asks*
whether to record them. Off until `meetey watch enable`; `disable`, `status`, and
`logs` round out the CLI (`cli/commands/watch.js`).

**It never starts a recording on its own.** Every recording it produces was
authorised by someone choosing a capture mode in a dialog naming the specific window.
That is what makes it safe for detection to be loose: a false positive costs one
dismissed dialog, so `MEETING_PATTERNS` is deliberately generous. Do not "tighten"
those patterns into silence — a missed meeting is unrecoverable, a spurious
prompt is not. Run `node daemon/watch.js --selftest` after touching them.

The prompt offers three choices — `Skip` / `Audio + screen` / `Audio only` — and
screen capture is **scoped to the window the watcher detected**, which is narrower
than `/meetey start`'s default. Consent stays per-recording: the agent proposes,
the person decides, in the same dialog that authorises the audio.

Withholding the screen option did not make anything safer. It meant a meeting
worth capturing visually could not be, without abandoning the prompt and starting
over from Claude Code — and the copy at the time promised "a separate prompt" that
no code path ever produced.

The **default button is the safe one** (`Skip`), against the usual
"default is rightmost" convention. An unprompted alert that can take focus
mid-call must not turn an absent-minded Return into a recording. Having a default
at all matters for keyboard users: with none, no button holds focus, which can
leave the affirmative choices mouse-only when Full Keyboard Access is off.

`parseDialogChoice` compares button titles exactly rather than by regex — the `+`
in `Audio + screen` is a metacharacter, and a pattern that silently failed to match
would start an audio-only recording for someone who asked for their screen.
`--selftest` covers every reply shape, including a timeout naming the default
button (which is still not consent).

A LaunchAgent, not a LaunchDaemon: `display dialog` needs the user's GUI session,
and this must never run for a user who is not logged in. Notification *action
buttons* would need a signed `.app` bundle, but `display dialog` gives a real
modal with buttons from a plain CLI, which is why the confirm-first design is
cheap. `giving up after` returns `gave up:true` *with the default button still
named*, so the timeout must be checked before the button — a prompt nobody
answered is not consent.

**`mcp-server/watch-agent.js`** — enabling and disabling the agent. It lives under
`mcp-server/` rather than `cli/` because both `meetey watch` and the MCP server's
`enable_watcher` need it, and only `mcp-server/` and `daemon/` are copied into
`~/.meetey` — the CLI runs from the npx package and isn't on the machine
afterwards. Every path is derived from arguments, never the environment, so the
CLI's idea of where meetey lives can't drift from the server's. The skill must
not enable the watcher unprompted: it installs a login agent that survives
restarts, so it is a thing to offer, not to switch on helpfully.

**`mcp-server/session-state.js`** — the single answer to "is a recording running",
shared across processes. The MCP server's in-memory state was sufficient while it
was the only thing that could start a recording; the agent is a separate process,
so without a file on disk a recording it started is invisible to `/meetey stop`
and both could record the same meeting. Liveness is the **pid**, never the file:
a crashed capture otherwise leaves a state file that blocks every future
recording until someone deletes it by hand.

`transcribe` reuses `<wav>.json` when it is newer than the WAV, because the agent
runs whisper as soon as a recording ends. Re-running it on an hour of audio to
get a byte-identical result is minutes wasted.

## Menu bar indicator

`--menu-bar` (on by default from `start_recording`, and always for watcher-started
recordings) puts an `NSStatusItem` in the menu bar for the life of the recording:
a record icon, the elapsed time, and a **Stop Recording** item wired to the same
`fireOnce()` path as SIGTERM.

It is as much a consent surface as a control. Every other signal Meetey gives is a
moment in time — a prompt, a command, a confirmation. This is the only one that
stays true for the whole meeting, so don't make it opt-in and don't hide it behind
a preference.

A status item does **not** need an app bundle: `.accessory` activation policy plus
AppKit's run loop is enough, which is why `main.swift` calls `NSApplication.run()`
instead of `RunLoop.main.run()` when `--menu-bar` is set. (Notification *action
buttons* are the thing that genuinely requires bundling — see the watch agent,
which uses `display dialog` for that reason. Plain `display notification` needs no
bundle either, which is how the post-stop notice is posted.)

**The icon must be built with a palette configuration, never left as-is.**
`NSImage(systemSymbolName:)` returns `isTemplate = true`, and a template image
renders **monochrome** in the menu bar — indistinguishable from every other icon up
there, which is the one thing an indicator that exists to be noticed must not be.
`RecordingIndicator.symbol(_:color:)` applies `SymbolConfiguration(paletteColors:)`,
which returns a non-template image. This was shipped wrong once; don't revert it.

Four states, and colour is never the only thing separating them — shape carries it
too, so they survive menu bar tinting and colour-blind users:

| State | Symbol | Colour | Bar |
|---|---|---|---|
| Recording, audio | `record.circle.fill` | red | elapsed |
| Recording, + screen | `rectangle.inset.filled.badge.record` | red | elapsed |
| Call ending soon | `record.circle` (hollow) | secondary | "ending soon" |
| Stopping | `record.circle` | tertiary | "…" |

Audio-only and audio-plus-screen must never look identical — they are materially
different things to have consented to.

**"Keep Recording" appears only while a stop is pending**, and restarts the
call-end clock via `resetCandidate()`. Surfacing an imminent automatic stop obliges
us to let the user refuse it; without the veto the feature is something done *to*
them. It must not construct a fresh `MeetingEndMonitor` — that clears `armed`,
which can only be set by the mic being *in use*, so a single veto would silently
disable call-end detection for the rest of the recording.

VoiceOver gets state, not a control name: "Meetey recording, audio only, 25
minutes". Durations are spoken as words because "12:04" read as digits is not a
duration. Window titles are middle-truncated to 40 characters — the tail
identifies a meeting as much as the head does.

`RecordingIndicator.init` is failable and returns nil when `NSScreen.screens` is
empty — no GUI session, e.g. over ssh. A missing indicator must never take the
recording down with it. `--label` names what is being recorded; the skill passes
the window title, the watcher passes the meeting window's title.

## Call-end detection

`--stop-when-call-ends` (on by default from `start_recording`; `stopWhenCallEnds:
false` opts out) ends a recording when the *call* ends, as distinct from the app
closing. This is the thing auto-stop deliberately does not attempt, and it is only
safe because of how it commits.

**It never stops anything early.** When the microphone is released it records a
*candidate* end — the time, and the byte offset the recording had reached — and
keeps recording. If the mic comes back the candidate is discarded and nothing was
lost. Only after `--call-end-grace` (default 600s) does it commit, and the WAV is
then truncated back to the candidate offset so the waiting never reaches the
transcript. Separating *when to stop* from *where the recording ends* is what
makes a long grace period free, which in turn is what makes the evidence good.

Three guards, each covering a different way the naive version goes wrong:

- **Armed only after the mic has been seen in use.** A recording where no app ever
  took the microphone is not a call whose end this can detect; without this it
  would fire on every such recording.
- **An audible-audio veto.** `WAVWriter` tracks the offset of the last sample above
  `audibleAmplitude` (300, deliberately low — being wrong in the quiet direction
  trims a live meeting, being wrong in the loud direction only records longer). If
  anything was audible after the candidate, the call plainly did not end there:
  the candidate is dropped and the clock restarts. This is what protects a muted
  listener whose app releases the mic mid-call.
- **A failed device query is not "released".** `Microphone.inUse()` returns nil on
  error and the poll skips that round.

`kAudioDevicePropertyDeviceIsRunningSomewhere` needs **no microphone permission** —
it is a device property, not audio content. Verified against a build with none
granted. Muting yourself does not release the device, so the signal survives it.

Do not swap the mic signal for window-title matching. For Chrome, `SCWindow.title`
is the *active tab's* title, so switching tabs mid-call looks exactly like hanging
up.

`MeetingEndMonitor` is a pure state machine; `--selftest` covers unarmed silence,
the grace period, blip recovery with a restarted clock, byte-accurate truncation
including the odd-byte case, and the audible/silent distinction.

## Auto-stop

`--auto-stop` (passed by default from `start_recording`; set `autoStop: false` to
opt out) ends a recording when the target app quits, or when the window given to
`--window` closes — each after a 30s grace period, so a window destroyed and
recreated (Zoom does this entering full screen) doesn't cut a live meeting.

It is deliberately **not** meeting detection. It does not try to infer that a
*call* ended while the app keeps running, because the costs are asymmetric:
stopping late wastes disk, stopping early loses the rest of a meeting that cannot
be re-recorded. Don't add heuristics like "the Zoom window title stopped saying
Meeting" without confronting that asymmetry — and note window titles are
localized.

App liveness is checked with `NSRunningApplication`, not
`SCShareableContent.applications`: an app whose windows are all minimized can
drop out of shareable content while the meeting is still running and still
producing audio.

`AutoStopMonitor` is a pure state machine so `--selftest` covers the grace
period, blip recovery, and both stop conditions without a live meeting.

Because the process can now exit on its own, the MCP server keeps the session in
`finishedRecording` when the child exits unprompted, so `stop_recording` still
returns the files instead of "No active recording" — which would strand a good
WAV the user has no obvious way to reach. `get_status` surfaces the same thing.

## Notes Output

The notes are the product, so the template is load-bearing. Four rules it exists to enforce:

- **Every claim carries its timestamp.** Decisions, action items, and screen notes all render `[mm:ss]` (`[h:mm:ss]` past the hour) derived from segment `fromMs` or frame `offsetMs`. Without this a reader who doubts one line has to search thousands of words of raw ASR, which is the thing the summary exists to replace.
- **The transcript is a sibling file, never inline and never printed to chat.** An hour of speech is ~9,000 unattributed words; at equal heading weight it buries the two action items someone actually came back for.
- **Empty states diagnose.** "No decisions recorded" is true both when a meeting made none and when transcription was too poor to find them, and only the second is actionable. Branch the copy on `quality.level`.
- **Filenames are browsable.** `YYYY-MM-DD-HHMM-<slug>.md`, with YAML front matter linking back to the session, WAV, and frames. Epoch-stamped names are ungreppable.

The critique that produced these rules is in `.impeccable/critique/`, which is
local-only and not committed — so treat the four rules above as the record.

**`docs/video-capture-plan.md`** — Design rationale for screen capture. Read before changing the keyframe pipeline.

**`cli/`** — The `meetey` CLI (`bin` entry in `package.json`). `index.js` dispatches to `commands/install.js`, `commands/update.js`, and `commands/status.js`; `paths.js` holds every install path in one place. `install` checks the macOS version, installs whisper-cpp via Homebrew, downloads `ggml-base.en.bin`, builds and code-signs the Swift binary, installs the MCP server and skill, and adds Claude Code shortcuts.

## Packaging

`files` in `package.json` enumerates `mcp-server/*.js` **individually**. Adding a
file there and forgetting this list ships a package whose `index.js` imports
something that isn't in it — and because `update` replaces the MCP server before
anything else, the result is a broken install whose error points somewhere else
entirely. This has happened; `session-state.js` was the casualty.

Listing `mcp-server/` as a directory instead is *not* the fix: it sweeps in
`mcp-server/node_modules` (24 MB, thousands of files).

The reliable check is to run the packaged artifact, not to read the manifest:

```bash
npm pack --pack-destination /tmp/p && tar xzf /tmp/p/*.tgz -C /tmp/p
cd /tmp/p/package/mcp-server && npm install && cd ..
node mcp-server/index.js   # must answer tools/list
node daemon/watch.js --selftest
```

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
- **Keyframes are written when the screen *stops* moving, not when it starts.** A detected change becomes a pending candidate; it is persisted only once a later sample shows the screen has come to rest (a stricter threshold than the change one). A slide transition therefore yields one file instead of one per intermediate, and that file is the settled frame, which also OCRs far better than anything caught mid-fade. `--max-unsettled` (default 60s) force-captures a screen that never settles, so a video demo still yields roughly a frame a minute instead of nothing. A candidate still pending when the meeting ends is flushed by `finalize()` rather than lost.
- **Cells that are always moving are masked out.** A rolling 15-sample window marks a cell volatile when it moved in ≥60% of samples; volatile cells don't count toward the threshold. This is what makes the standard slide-plus-speaker-tile layout produce one keyframe per slide instead of one per sample. Two details are load-bearing: **hysteresis** (a cell leaves the mask only below 30%, since cells straddling a moving region's edge otherwise flicker in and out and leak enough cells to clear the threshold on their own) and **one-cell dilation** (the grid averages ~40×22px per cell, so a tile's boundary lands mid-cell and moves less than its interior). `--no-volatility-mask` disables it. Note the interaction with the paragraph above: a full-screen video makes *every* cell volatile, so the mask alone would record nothing — the `--max-unsettled` valve is what prevents that, and it deliberately checks the *unmasked* delta.
- **`--display` and `--window` narrow the source.** The default display is the one showing the target app, not `displays.first` — on a multi-monitor setup those are often different, and capturing the wrong one yields a session of irrelevant keyframes. `--window` scopes to a single window via `SCContentFilter(display:including:[window])`, excluding the app's other windows and its notification banners from both the frame and the change detector. `--list-displays` and `--list-windows` enumerate the choices. **ScreenCaptureKit has no concept of a tab** — window is the finest granularity the platform offers, and user-facing copy must not imply otherwise.
- **`MEETEY_DEBUG_KEYFRAMES=1`** prints a per-sample decision trace (masked vs unmasked delta, settle delta, volatile cell count). Resolved once at startup — reading the environment per sample would put a dictionary build on the capture callback.
- **Two queues.** Grid comparison runs on the capture callback; JPEG encoding and OCR run on a separate serial queue. Blocking the callback makes ScreenCaptureKit drop frames.
- **Only `.complete` frames count.** SCKit delivers idle/blank/suspended frames; hashing those produces spurious keyframes on a static screen.
- **`showsCursor = false`** — a moving cursor otherwise changes the grid and emits keyframes on an unchanged screen.
- **Capture at pixel dimensions, not points.** `SCDisplay.width/height` are points; use `CGDisplayCopyDisplayMode().pixelWidth`. Capturing at point dimensions on a Retina display halves resolution and makes OCR unusable.
- OCR runs on the native-resolution buffer via `VNRecognizeTextRequest`; the persisted JPEG is downscaled to a 2576px long edge.

Artifacts land in `~/.meetey/recordings/<session>-frames/` with an `index.json` manifest (`file`, `offsetMs`, `fingerprint`, `ocrText`). They are never auto-deleted — the notes reference them.

## Known Limitations

ScreenCaptureKit captures **audio** at the process level. When targeting Chrome, all Chrome audio is captured — not just the meeting tab. Users should mute other tabs playing audio before starting a recording.

For **video**, `--window` narrows capture to a single window, which keeps the app's other windows and its notification banners out of frame. It cannot go finer: there is no tab-level capture on macOS, so whatever tab the captured window is showing is what gets captured, including after a tab switch. Isolating one tab means dragging it into its own window.

**Camera-heavy calls no longer burn the frame budget.** A moving video tile is masked as volatile and a tile that never settles is never persisted, so the slide-plus-speaker-tile layout yields about one keyframe per slide. A call that is *only* faces still produces little of value — audio-only remains the right choice there — but it no longer exhausts `--max-frames` in the first few minutes and go dark for the rest of the meeting.

## Model

Default: `ggml-base.en.bin` (~142 MB) stored at `~/.meetey/models/`. Override with `MEETEY_MODEL` env var. Larger models (`small.en`, `large-v3-turbo-q5_0`) give better accuracy — download the model to `~/.meetey/models/` and update `MEETEY_MODEL` in the `mcpServers.meetey.env` section of `~/.claude.json` to switch.

## Claude Code shortcuts

- `Ctrl+Shift+R` — `/meetey start`
- `Ctrl+Shift+S` — `/meetey stop`

Written into `~/.claude/keybindings.json` with `action: "sendMessage"`, so they send a
message into the session and **only fire while Claude Code is focused**. Nothing here
registers a system-wide hotkey, and user-facing copy must not call them "hotkeys" — on
macOS that word implies global, and someone will try one mid-meeting and get nothing.

This leaves an asymmetry worth knowing: the menu bar item stops a recording from
anywhere, but nothing starts one without either Claude Code or the watcher offering.
A global hotkey would need Accessibility permission and an always-running process; the
watcher is already that process, but a hotkey that silently starts recording is the
consent posture this project avoids.

## License

Apache 2.0. Every source file carries the standard Apache header — add it to any
new `.js` or `.swift` file. `LICENSE` is the verbatim Apache text and should not
be edited; copyright and third-party attributions live in `NOTICE`.

Never commit recordings, transcripts, or `.claude/settings.local.json` — see
`.gitignore`.
