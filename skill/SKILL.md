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

### Gather

1. Call `stop_recording`. If no recording is active, say so.
2. Call `transcribe` with the returned `outputPath`. It returns:
   - `transcript` — the full text
   - `segments` — `{ text, fromMs, toMs }` per utterance
   - `durationMs` / `durationLabel` — exact length, read from the WAV header
   - `model` — the Whisper model that produced this
   - `quality` — `{ level, reason, spokenWordsPerMinute, degradedRatio, silenceRatio }`, where `level` is `good`, `fair`, `poor`, or `unusable`
3. If the stop result includes `framesDir`, call `get_keyframes` with it. Each frame has `path`, `offsetMs`, and usually `ocrText`.
4. If transcription fails, report the error and point the user at the Troubleshooting table in the README.

### Interpret

- **Use `ocrText` as the primary signal for screen content.** It is already extracted and costs nothing extra.
- **Read a keyframe image directly** (with the Read tool, using its `path`) only when OCR is insufficient — a diagram, chart, architecture sketch, whiteboard, or UI screenshot where layout carries the meaning, or when `ocrText` is missing or obviously garbled. Read at most a handful; do not read every frame.
- **Anchor every claim to a timestamp.** Each decision, action item, and screen-content note carries the offset where it happened, formatted `[mm:ss]` (or `[h:mm:ss]` past the hour). Derive it from the `fromMs` of the segment the claim came from, or a frame's `offsetMs`. This is what makes the notes checkable — a reader who doubts a line can jump straight to it in the transcript instead of searching thousands of words.
- **Let `quality` set your confidence.** At `fair` or below, prefer quoting what was actually said over paraphrasing, and don't manufacture decisions from ambiguous fragments.

### Output

Produce this document. Print it in chat *and* write it to a file — it no longer contains the transcript, so there is no wall of text to duplicate.

---

## [Meeting title — inferred from transcript/slides, or "Meeting [date]"]

**Recorded:** [Fri 1 Aug 2026, 2:02–2:47 PM] · [durationLabel]
[Quality callout — include only when `quality.level` is not `good`, formatted as a blockquote:]
> ⚠️ **Transcription quality: [level]** — [quality.reason]. Summary may be incomplete; [model] was used. For better accuracy, see "Whisper model" in the README.

### Summary
[2–4 sentence overview of what was discussed, drawing on both what was said and what was shown]

### Key Decisions
- **[12:04]** [decision]
*(Empty-state copy is diagnostic — see below.)*

### Action Items
- [ ] **[31:17]** [task] — [owner if named] · [due date if stated]
*(Empty-state copy is diagnostic — see below.)*

### Screen Content
*(Include this section only when keyframes were captured.)*
- **[04:12]** [what was on screen, in one clause]
*(If keyframes were captured but showed nothing meaningful: "Screen content captured, but no slides or shared material identified.")*

### Transcript
Full transcript: [`<notes-stem>-transcript.md`] · [N] words · [model]

---

**Empty states must diagnose, not just report.** "No decisions recorded" is true both when a meeting genuinely made none and when the transcription was too poor to find them, and only the second is actionable. Branch on `quality.level`:

- `good` → "No decisions were made — this was a discussion." / "No action items were assigned."
- `fair` or `poor` → "No decisions could be extracted, and transcription quality was [level] ([reason]) — this may be a transcription problem rather than a meeting without decisions. Try a larger model: set `MEETEY_MODEL` to `ggml-small.en.bin` (see the README)."
- `unusable` → Don't produce a summary at all. Say the recording captured no usable speech, give the likely causes (wrong app targeted, the app was muted, or Screen Recording permission is missing), and point at the README's Troubleshooting table.

### Write the files

1. **Notes** → `~/.meetey/recordings/YYYY-MM-DD-HHMM-<short-slug>.md`, where the slug is 2–4 kebab-case words from the meeting title. A human-readable, chronologically sortable name — epoch-stamped filenames are unbrowsable. Lead the file with YAML front matter so the artifacts stay linked:
   ```yaml
   ---
   session: meetey-1754049600
   recorded: 2026-08-01T14:02:11Z
   duration: 45 min
   model: ggml-base.en.bin
   quality: good
   audio: meetey-1754049600.wav
   frames: meetey-1754049600-frames/    # omit when audio-only
   ---
   ```
2. **Transcript** → the same stem with `-transcript.md`. Front matter linking back to the notes, then the transcript as timestamped paragraphs — one line per segment, `**[mm:ss]** text` — not one undifferentiated block. This is the file a reader jumps into from a timestamp, so it has to be navigable.
3. Tell the user, briefly — this is a receipt, not a second copy of the document:
   > Notes: `<notes path>`
   > Transcript: `<transcript path>` · Audio: `<wav path>`
   > [N keyframes in `<framesDir>` — delete that folder if you don't want the screen captures kept.]
4. If `truncated` is true on the stop result, say so plainly: "The keyframe limit was reached, so screen content after [offset of last frame] wasn't captured." Never present a truncated capture as complete.

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
