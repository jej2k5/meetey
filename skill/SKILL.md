---
description: "Capture and transcribe meeting audio. Commands: start | stop | status"
---

# Meetey Skill

Meetey captures meeting audio locally using ScreenCaptureKit, transcribes it with whisper.cpp, and produces a structured summary — all without data leaving your machine.

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
5. Call `start_recording` with the chosen `bundleID`.
6. Confirm to the user: "Recording started. Run `/meetey stop` or press `Ctrl+Shift+S` when the meeting ends."

**Chrome note:** Chrome captures all tab audio, not just the meeting tab. Close other tabs playing audio or mute them before starting.

---

## `/meetey stop`

1. Call `stop_recording`. If no recording is active, say so.
2. Call `transcribe` with the returned `outputPath`.
3. If transcription fails, report the error clearly.
4. With the transcript text, produce the following structured output:

---

## [Meeting title — inferred from transcript or "Meeting [date]"]

**Recorded:** [startedAt → stoppedAt]

### Summary
[2–4 sentence overview of what was discussed]

### Key Decisions
- [decision 1]
- [decision 2]
*(If none identified: "No explicit decisions recorded.")*

### Action Items
- [ ] [task] — [owner if mentioned]
*(If none identified: "No action items recorded.")*

### Full Transcript
[raw transcript text]

---

After producing output:
1. Write the full structured summary (everything from `## [Meeting title]` through the Full Transcript section) to a markdown file at the same path as the WAV but with a `.md` extension (e.g. if outputPath is `/path/to/meetey-1234.wav`, write to `/path/to/meetey-1234.md`).
2. Tell the user: "WAV saved to [outputPath]. Notes saved to [mdPath]."

---

## `/meetey status`

Call `get_status` and report:
- If active: "Recording in progress since [startedAt] — session [sessionId]."
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
