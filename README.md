# meetey

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey.svg)](#requirements)

Local-first meeting capture and transcription for Claude Code. Records audio from running meeting apps using macOS ScreenCaptureKit, transcribes locally with whisper.cpp, and produces structured notes via Claude — no data leaves your machine, no subscriptions, no cloud.

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

Or use the hotkeys:

| Hotkey | Action |
|--------|--------|
| `Ctrl+Shift+R` | `/meetey start` |
| `Ctrl+Shift+S` | `/meetey stop` |

### Workflow

1. Join your meeting in Chrome (Google Meet / Teams web), Zoom, or Microsoft Teams
2. Run `/meetey start` — Claude detects the running app and begins recording
3. When the meeting ends, run `/meetey stop` — Claude transcribes the audio and produces:

```
## [Meeting title]

**Recorded:** 10:02 AM → 10:47 AM

### Summary
...

### Key Decisions
- ...

### Action Items
- [ ] task — owner

### Full Transcript
...
```

Notes are saved as a `.md` file alongside the WAV in `~/.meetey/recordings/`.

### Supported apps

| App | What gets captured |
|-----|--------------------|
| Chrome | All Chrome audio (mute other tabs) |
| Zoom | Zoom meeting audio |
| Microsoft Teams (desktop) | Teams meeting audio |

> **Chrome note:** ScreenCaptureKit captures at the process level, not the tab level. Mute any other Chrome tabs playing audio before starting.

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

## How it works

```
/meetey skill → MCP server (Node.js, ~/.meetey/mcp-server/) → meetey-capture (Swift, ~/.meetey/)
                                                             → whisper-cli
```

**meetey-capture** is a Swift CLI using ScreenCaptureKit. It takes `--app <bundle-id>` and `--output <path.wav>`, records app audio as 16-bit PCM WAV at 16 kHz mono, and stops on SIGTERM.

**MCP server** manages the capture process lifecycle and shells out to `whisper-cli` for transcription. Registered globally in `~/.claude.json` so it's available in every Claude Code session.

**`/meetey` skill** drives the user-facing flow: `list_apps → start_recording → stop_recording → transcribe`, then formats and saves the output.

## Files written

| Path | Contents |
|------|----------|
| `~/.meetey/recordings/*.wav` | Raw audio from each session |
| `~/.meetey/recordings/*.md` | Structured notes (summary, decisions, action items, transcript) |
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
