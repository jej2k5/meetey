# meetey

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey.svg)](#requirements)

Local-first meeting capture and transcription for Claude Code. Records audio from running meeting apps using macOS ScreenCaptureKit, transcribes locally with whisper.cpp, and produces structured notes via Claude. Optionally captures screen content too — slides, screen shares, code — with text recognized on-device.

Recording and transcription happen entirely on your machine. No subscriptions, no third-party meeting bots, no cloud transcription service. See [What stays local](#what-stays-local) for exactly what is and isn't sent anywhere.

## Install

Requires macOS 13+, Node.js 18+, and Xcode Command Line Tools.

```bash
npx jej2k5/meetey install
```

This will:
- Install whisper-cpp via Homebrew (if not already present)
- Download the Whisper base model (~142 MB) to `~/.meetey/models/`
- Build and sign the Swift capture binary
- Register the MCP server in Claude Code
- Install the `/meetey` skill
- Add hotkeys (`Ctrl+Shift+R` / `Ctrl+Shift+S`)

After installation, open System Settings → Privacy & Security → Screen Recording and enable your terminal app. Then start a new Claude Code session.

## Usage

### In Claude Code

```
/meetey start    Detect running meeting apps and start recording
/meetey stop     Stop recording, transcribe, and save notes
/meetey status   Check whether a recording is active
```

`/meetey start` asks whether to also capture screen content. Answer up front to skip the question:

```
/meetey start --video       Audio + screen keyframes
/meetey start --audio-only  Audio only
```

Or use the hotkeys:

| Hotkey | Action |
|--------|--------|
| `Ctrl+Shift+R` | `/meetey start` |
| `Ctrl+Shift+S` | `/meetey stop` |

### Workflow

1. Join your meeting in Chrome (Google Meet / Teams web), Zoom, or Microsoft Teams
2. Run `/meetey start` — Claude detects the running app, asks whether to capture screen content, and begins recording
3. When the meeting ends, run `/meetey stop` — Claude transcribes the audio, reads any screen content, and produces:

```
## Q3 Roadmap and API Cutover

**Recorded:** Fri 1 Aug 2026, 2:02–2:47 PM · 45 min

### Summary
...

### Key Decisions
- **[12:04]** Ship v1.1 without the motion heuristic; revisit next cycle

### Action Items
- [ ] **[31:17]** Draft the migration doc — Priya · due Friday

### Screen Content          ← only when screen capture was used
- **[04:12]** Burndown chart, actual tracking ~11 days behind plan

### Transcript
Full transcript: `2026-08-01-1402-q3-roadmap-transcript.md` · 6,180 words
```

**Every claim carries the timestamp it came from.** If you doubt a decision, jump straight to that moment in the transcript instead of searching thousands of words.

Notes are written to `~/.meetey/recordings/` as `YYYY-MM-DD-HHMM-<slug>.md` — chronologically sortable, so `ls` is a meeting history. The transcript lives in a sibling `-transcript.md` file rather than inline, so the notes stay scannable.

When the transcription is unreliable, the notes say so at the top instead of summarizing noise with a confident voice:

```
> ⚠️ Transcription quality: poor — 80% of segments were silence markers,
> fragments, or repeats. Summary may be incomplete; ggml-base.en.bin was used.
```

That assessment is computed from the transcript itself (fragment rate, whisper looping, speech pace against spoken time), not guessed.

### Supported apps

| App | Audio captured | Screen captured (opt-in) |
|-----|----------------|--------------------------|
| Chrome | All Chrome audio | Everything Chrome displays — all tabs and windows |
| Zoom | Zoom meeting audio | The Zoom window, including screen shares |
| Microsoft Teams (desktop) | Teams meeting audio | The Teams window, including screen shares |

> **Chrome note:** ScreenCaptureKit captures at the **process** level, not the tab level. Mute any other Chrome tabs playing audio before starting — and if you opt into screen capture, close or hide anything you don't want recorded, because every Chrome tab and window is in frame.

## Screen capture

Meetey can also capture what was on screen — slides, screen shares, code, diagrams — and fold it into the notes.

**It is off by default and opt-in per meeting.** Claude asks every time you run `/meetey start`; there is no setting that turns it on permanently. Skip the question with `/meetey start --video` or `/meetey start --audio-only`.

```
/meetey start --video     Record audio + screen keyframes
/meetey start --audio-only  Record audio only, don't ask
```

Instead of recording video, Meetey samples the screen once a second and keeps a JPEG **only when the picture materially changes**. An hour-long meeting typically yields a few dozen keyframes rather than 3,600, which is what makes this cheap enough to be worth doing:

| | Storage/hr | Sent to Claude |
|---|---|---|
| Audio | ~115 MB | ~12K tokens (transcript) |
| Screen keyframes | ~10 MB | ~5K tokens (recognized text) |

Text is recognized on-device with the macOS Vision framework, so the default path sends only text. Claude reads an actual keyframe image only when the text isn't enough — a diagram, a chart, a UI screenshot.

> ⚠️ **Screen capture records everything the target app displays** — other tabs, other windows of that app, and notification banners that appear over it. A screen share can contain credentials, customer data, or a colleague's private dashboard. Close or mute anything sensitive before you opt in.

Keyframes are written to `~/.meetey/recordings/<session>-frames/` and are **not** deleted automatically — the notes reference them, so removing them would make the summary unverifiable. Delete that folder yourself when you're done with it.

Tuning, if you need it (pass through to `meetey-capture`):

| Flag | Default | Purpose |
|---|---|---|
| `--fps <n>` | `1` | Frames sampled per second |
| `--scene-threshold <n>` | `12` | Grid cells (of 1024) that must change to count as a new scene. Raise it if a video tile is producing too many keyframes |
| `--max-frames <n>` | `200` | Hard cap per session |
| `--no-ocr` | off | Skip on-device text recognition |

**Camera-heavy calls are a poor fit.** A moving video tile changes the picture constantly and will burn through the frame budget. Screen capture pays off for slides, demos, and screen shares; for a faces-only discussion, stay on audio.

## What stays local

| Stays on your machine, always | Sent to Claude to write the summary |
|---|---|
| Meeting audio (the WAV) | The transcript text |
| Screen keyframes (the JPEGs) | Recognized on-screen text (OCR) |
| Whisper transcription — runs locally | A few keyframe **images**, only when text isn't enough |
| Vision OCR — runs on-device | |

Nothing is uploaded to a third-party meeting service, and no bot joins your call. Audio and images never leave your machine unless Claude needs a specific keyframe to interpret a diagram. Summarization itself runs through Claude, so the *text* does go to the API — the same as anything else you'd paste into Claude Code.

## CLI

```bash
npx jej2k5/meetey install   # First-time setup
npx jej2k5/meetey update    # Rebuild binary and refresh MCP server + skill
npx jej2k5/meetey status    # Show what's installed and whether everything is wired up
```

`status` output:

```
Meetey status

  ✔  meetey-capture binary  (~/.meetey/meetey-capture/.build/release/meetey-capture)
  ✔  binary code-signed
  ✔  whisper-cli  (/opt/homebrew/bin/whisper-cli)
  ✔  Whisper model (ggml-base.en.bin)  (~/.meetey/models/ggml-base.en.bin)
  ✔  MCP server files  (~/.meetey/mcp-server)
  ✔  MCP server registered in ~/.claude.json
  ✔  /meetey skill installed
  ✔  Hotkeys registered  (Ctrl+Shift+R / Ctrl+Shift+S)
```

## Requirements

- macOS 13 (Ventura) or later
- Node.js 18+
- Xcode Command Line Tools (`xcode-select --install`)
- Claude Code
- Homebrew (installed automatically if missing)

## Whisper model

The default model is `ggml-base.en.bin` (~142 MB), stored at `~/.meetey/models/`. It handles clear English speech well. For better accuracy on accented speech or technical vocabulary, switch to a larger model:

| Model | Size | Notes |
|-------|------|-------|
| `ggml-base.en.bin` | 142 MB | Default. Fast, good for clear English. |
| `ggml-small.en.bin` | 466 MB | Better accuracy. |
| `ggml-large-v3-turbo-q5_0.bin` | 1.1 GB | Best accuracy. Slower. |

To switch, download the model to `~/.meetey/models/` and set `MEETEY_MODEL` in the `mcpServers.meetey.env` section of `~/.claude.json`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `meetey-capture binary not found` | Run `npx jej2k5/meetey install` |
| `Whisper model not found` | Run `npx jej2k5/meetey install` |
| App not listed by `/meetey start` | Ensure the meeting app is open and a call is active |
| Blank or garbled transcript | Check Screen Recording permission: System Settings → Privacy & Security → Screen Recording |
| Chrome captures wrong audio | Mute other tabs playing audio before starting |
| MCP tools not available after install | Restart Claude Code — MCP servers connect at session startup |
| No screen content in the notes | Screen capture is opt-in per meeting — start with `/meetey start --video` |
| Too many near-identical keyframes | A video tile or animation was on screen. Raise `--scene-threshold`, or use audio-only for camera-heavy calls |
| Slide changes missed | Lower `--scene-threshold` (fewer cells needed to count as a new scene) |
| Keyframe text is garbled | Confirm the meeting window isn't scaled down; OCR runs on the captured resolution |

## How it works

```
/meetey skill → MCP server (Node.js, ~/.meetey/mcp-server/) → meetey-capture (Swift, ~/.meetey/)
                                                             → whisper-cli
```

**meetey-capture** is a Swift CLI using ScreenCaptureKit. It takes `--app <bundle-id>` and `--output <path.wav>`, records app audio as 16-bit PCM WAV at 16 kHz mono, and stops on SIGTERM. With `--video` it also samples the screen, keeps a JPEG when the picture changes, and runs Vision OCR on each one.

**MCP server** manages the capture process lifecycle and shells out to `whisper-cli` for transcription. Registered globally in `~/.claude.json` so it's available in every Claude Code session.

**`/meetey` skill** drives the user-facing flow: `list_apps → start_recording → stop_recording → transcribe → get_keyframes`, then formats and saves the output.

Run `meetey-capture --selftest` to exercise the keyframe pipeline (scene detection, JPEG encoding, OCR, manifest) with synthetic frames — no Screen Recording permission or live meeting required.

## Files written

| Path | Contents |
|------|----------|
| `~/.meetey/recordings/*.wav` | Raw audio from each session |
| `~/.meetey/recordings/YYYY-MM-DD-HHMM-<slug>.md` | Structured notes — summary, timestamped decisions and action items, screen content |
| `~/.meetey/recordings/YYYY-MM-DD-HHMM-<slug>-transcript.md` | Full transcript, one timestamped line per utterance |
| `~/.meetey/recordings/*-frames/` | Screen keyframes + `index.json` (only when screen capture was used) |
| `~/.meetey/models/ggml-base.en.bin` | Whisper model |
| `~/.meetey/mcp-server/` | MCP server (stable install location) |
| `~/.meetey/meetey-capture/` | Swift binary and sources |

## Contributing

Issues and pull requests are welcome. To work on Meetey from a local clone:

```bash
git clone https://github.com/jej2k5/meetey.git
cd meetey
node cli/index.js install     # build, sign, and register everything locally
```

After changing Swift sources, rebuild and re-sign:

```bash
cd meetey-capture
swift build -c release
codesign --force --sign - --options runtime --entitlements entitlements.plist \
  .build/release/meetey-capture
```

Then restart Claude Code so the MCP server reconnects.

New source files should carry the Apache 2.0 header used by the existing files.
By contributing, you agree that your contributions are licensed under the Apache
License 2.0.

## License

Copyright 2026 John Joseph

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at [http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0).

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the [LICENSE](LICENSE)
file for the specific language governing permissions and limitations under the
License.

Third-party attributions are listed in [NOTICE](NOTICE).
