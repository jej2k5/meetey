# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Meetey** is a local-first meeting capture and summarization tool that runs entirely within Claude Code. It captures audio from running meeting apps (Google Meet, Zoom, Microsoft Teams) using macOS ScreenCaptureKit, transcribes locally with whisper.cpp, and produces structured summaries via Claude — no data leaves the machine, no third-party services.

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

**`meetey-capture/`** — Swift CLI using ScreenCaptureKit. Takes `--app <bundle-id>` and `--output <path.wav>`, records app audio as 16-bit PCM WAV at 16 kHz mono, stops on SIGTERM/SIGINT or after `--stop-after <seconds>` of wall-clock time. Also supports `--list-apps`, which prints running supported apps as JSON. Requires macOS 13+.

**`mcp-server/index.js`** — Node.js MCP server. Manages the capture process lifecycle and shells out to `whisper-cli` for transcription. Exposes five tools: `list_apps`, `start_recording`, `stop_recording`, `transcribe`, `get_status`. Registered globally in `~/.claude.json` by the installer.

**`skill/SKILL.md`** — The `/meetey` slash command, with `start`, `stop`, and `status` subcommands. `start` drives `list_apps → start_recording`; `stop` drives `stop_recording → transcribe`, formats the summary, and writes it to a `.md` file alongside the WAV; `status` calls `get_status`.

**`cli/`** — The `meetey` CLI (`bin` entry in `package.json`). `index.js` dispatches to `commands/install.js`, `commands/update.js`, and `commands/status.js`; `paths.js` holds every install path in one place. `install` checks the macOS version, installs whisper-cpp via Homebrew, downloads `ggml-base.en.bin`, builds and code-signs the Swift binary, installs the MCP server and skill, and adds hotkeys.

## Supported App Bundle IDs

| App | Bundle ID |
|---|---|
| Chrome (Google Meet / Teams web) | `com.google.Chrome` |
| Zoom | `us.zoom.xos` |
| Microsoft Teams (desktop) | `com.microsoft.teams` |

## Known Limitation

ScreenCaptureKit captures at the **process level**, not the tab level. When targeting Chrome, all Chrome audio is captured — not just the meeting tab. Users should mute other tabs playing audio before starting a recording.

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
