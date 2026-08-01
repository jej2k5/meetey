---
description: "Capture and transcribe meeting audio, optionally with screen content. Commands: start | stop | status"
---

# Meetey Skill

Meetey captures meeting audio locally using ScreenCaptureKit, transcribes it with whisper.cpp, and produces a structured summary — all without audio leaving your machine.

It can optionally capture **screen keyframes** as well: slides, screen shares, code, and diagrams. Text is recognized on-device, so the default path still sends only text to Claude.

## Invocation

`/meetey [subcommand]`

Subcommands: `start`, `stop`, `status`. Running `/meetey` with no subcommand shows the available commands.

---

## `/meetey` (no subcommand)

Reply with exactly this, then wait for the user to choose:

```
Meetey — local meeting capture

  /meetey start    Start recording a meeting
  /meetey stop     Stop recording and transcribe
  /meetey status   Check if a recording is active
```

---

## `/meetey start`

1. Call `list_apps` to get running capturable apps.
2. If no apps are found, tell the user: "No supported meeting apps are running. Start your meeting in Chrome (Google Meet or Teams web), Zoom, or Microsoft Teams, then try again."
3. If exactly one app is found, confirm with the user: "I found [App Name]. Start recording?" and proceed on confirmation.
4. If multiple apps are found, show a numbered list and ask the user to choose.
5. **Ask about screen capture**, unless the user already said (`/meetey start --video` means yes, `/meetey start --audio-only` means no). Ask it as a plain question defaulting to no:

   > Also capture screen content (slides, screen shares, code)? This captures **everything [App Name] displays** — including other tabs, windows, and notifications — so mute or close anything sensitive first. Audio-only is the default. [y/N]

   Never skip this question when the user hasn't answered it, and never assume yes. Screen capture is opt-in for every single recording — there is no setting that turns it on permanently, by design.
6. Call `start_recording` with the chosen `bundleID`, and `captureVideo: true` only if the user explicitly opted in.
7. Confirm to the user: "Recording started[, capturing screen content]. Run `/meetey stop` or press `Ctrl+Shift+S` when the meeting ends."

**Chrome note:** Chrome captures all tab audio, not just the meeting tab. Close other tabs playing audio or mute them before starting. With screen capture on, the same applies visually.

---

## `/meetey stop`

1. Call `stop_recording`. If no recording is active, say so.
2. Call `transcribe` with the returned `outputPath`. This returns `transcript` (full text) and `segments` (each with `text`, `fromMs`, `toMs`).
3. If the stop result includes `framesDir`, call `get_keyframes` with it. Each frame has `path`, `offsetMs`, and usually `ocrText`.
4. If transcription fails, report the error clearly.
5. Build a picture of the meeting from both sources:
   - **Use `ocrText` as the primary signal for screen content.** It is already extracted and costs nothing extra.
   - **Read a keyframe image directly** (with the Read tool, using its `path`) only when OCR is insufficient — a diagram, chart, architecture sketch, whiteboard, or UI screenshot where layout carries the meaning, or when `ocrText` is missing or obviously garbled. Read at most a handful; do not read every frame.
   - **Align screen content with speech** using `offsetMs` against the segment `fromMs`/`toMs` values, so you know what was being said when each thing was shown.
6. Produce the following structured output:

---

## [Meeting title — inferred from transcript/slides, or "Meeting [date]"]

**Recorded:** [startedAt → stoppedAt]

### Summary
[2–4 sentence overview of what was discussed, drawing on both what was said and what was shown]

### Key Decisions
- [decision 1]
- [decision 2]
*(If none identified: "No explicit decisions recorded.")*

### Action Items
- [ ] [task] — [owner if mentioned]
*(If none identified: "No action items recorded.")*

### Screen Content
*(Include this section only when keyframes were captured.)*
- **[mm:ss]** [what was on screen, and how it related to the discussion at that moment]
*(If keyframes were captured but showed nothing meaningful: "Screen content captured, but no slides or shared material identified.")*

### Full Transcript
[raw transcript text]

---

After producing output:
1. Write the full structured summary (everything from `## [Meeting title]` through the Full Transcript section) to a markdown file at the same path as the WAV but with a `.md` extension (e.g. if outputPath is `/path/to/meetey-1234.wav`, write to `/path/to/meetey-1234.md`).
2. Tell the user: "WAV saved to [outputPath]. Notes saved to [mdPath]." When keyframes were captured, add: "[N] keyframes in [framesDir] — delete that folder if you don't want the screen captures kept."
3. If `truncated` is true on the stop result, say so plainly: "The keyframe limit was reached, so screen content after [timestamp of last frame] wasn't captured." Never present a truncated capture as complete.

---

## `/meetey status`

Call `get_status` and report:
- If active: "Recording in progress since [startedAt] — session [sessionId]." Add "Capturing screen content." when `capturingVideo` is true.
- If inactive: "No recording active."

---

## Hotkeys

- `Ctrl+Shift+R` — start recording (`/meetey start`)
- `Ctrl+Shift+S` — stop recording and transcribe (`/meetey stop`)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "meetey-capture binary not found" | Run `npx jej2k5/meetey install` |
| "Whisper model not found" | Run `npx jej2k5/meetey install` |
| App not listed | Ensure the meeting app is open and a call is active |
| Blank or garbled transcript | Check Screen Recording permission in System Settings → Privacy & Security |
| Chrome captures wrong audio | Mute other tabs playing audio before starting the recording |
| No keyframes captured | The recording must be started with screen capture opted in; check `capturingVideo` via `get_status` |
| Too many near-identical keyframes | A video tile or animation was on screen. Re-run with a higher `--scene-threshold`, or use audio-only for camera-heavy calls |
