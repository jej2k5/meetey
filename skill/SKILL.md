---
description: "Capture and transcribe meeting audio, optionally with screen content, and manage the meeting library. Commands: start | stop | status | list | show | search | delete | doctor"
---

# Meetey Skill

Meetey captures meeting audio locally using ScreenCaptureKit, transcribes it with whisper.cpp, and produces a structured summary — all without audio leaving your machine.

It can optionally capture **screen keyframes** as well: slides, screen shares, code, and diagrams. Text is recognized on-device, so the default path still sends only text to Claude.

## Invocation

`/meetey [subcommand]`

Two groups of subcommands: `start`, `stop`, `status` drive a recording; `list`, `show`,
`search`, `delete`, `doctor` operate on the library of past ones. Running `/meetey` with
no subcommand shows the available commands.

Every library subcommand also has a plain-language equivalent — "what meetings do I have
this week?" is `/meetey list`. Both routes reach the same tools, so honour whichever the
user used and don't redirect them to the other.

---

## `/meetey` (no subcommand)

Reply with exactly this, then wait for the user to choose:

```
Meetey — local meeting capture

  /meetey start    Start recording a meeting
  /meetey stop     Stop recording and transcribe
  /meetey status   Check if a recording is active

  /meetey watch    Ask to record meetings automatically (off by default)

  /meetey list     Browse past meetings
  /meetey show     Open one meeting's notes
  /meetey search   Find a moment across every meeting
  /meetey delete   Remove a recording
  /meetey doctor   Check the install
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
6. **If — and only if — the user opted into screen capture, narrow the source.** Call `list_windows` with the chosen `bundleID` and offer the titled windows as a numbered list, defaulting to the whole app:

   > Which window? Capturing just one keeps the app's other windows and its notification banners out of frame entirely.
   > 1. Weekly Sync — Google Meet
   > 2. Everything Chrome shows (default)

   Then call `list_displays`. **Only ask about the display when it returns more than one** — otherwise pick silently. Skip this whole step for audio-only recordings; there is nothing visual to narrow.
7. Call `start_recording` with the chosen `bundleID`, `captureVideo: true` only if the user explicitly opted in, and `windowID`/`displayID` when the user chose them. Pass `label` too — the window title if one was listed, otherwise the app name — so the menu bar indicator names what it is recording rather than saying "Meeting".
8. Confirm to the user: "Recording started[, capturing screen content from <window title>]. Stop it from the menu bar, with `/meetey stop`, or with `Ctrl+Shift+S`."

The recording also ends itself if the app quits, or if the chosen window closes — so forgetting to stop costs a little disk, not a runaway recording. Don't advertise this as "it knows when your meeting ends": it does not detect a call ending while the app keeps running, and saying otherwise would leave someone expecting a stop that never comes.

**Chrome note:** Chrome captures all tab audio, not just the meeting tab. Close other tabs playing audio or mute them before starting.

**A single browser tab cannot be captured.** ScreenCaptureKit works at the window level and has no concept of a tab, so selecting a window narrows capture to that window — not to the tab currently shown in it. Say this plainly rather than implying tab-level control. If the user wants exactly one tab isolated, tell them to drag it into its own window and select that window. Note too that switching tabs inside the captured window captures the new tab.

---

## `/meetey stop`

### Gather

1. Call `stop_recording`. If no recording is active, say so. If the result has `autoStopped: true`, the recording had already ended by itself — carry on with the transcription exactly as normal, and mention the reason once ("the recording had already stopped — [autoStopReason]") rather than treating it as an error.
2. Call `transcribe` with the returned `outputPath`. It returns:
   - `transcript` — the full text
   - `segments` — `{ text, fromMs, toMs }` per utterance
   - `durationMs` / `durationLabel` — exact length, read from the WAV header
   - `model` — the Whisper model that produced this
   - `quality` — `{ level, reason, spokenWordsPerMinute, degradedRatio, silenceRatio }`, where `level` is `good`, `fair`, `poor`, or `unusable`
3. If the stop result includes `framesDir`, call `get_keyframes` with it. Each frame has `path`, `offsetMs`, and usually `ocrText`. A frame may also have `revisitsMs`: later offsets at which that same screen came back on stage. Treat those as additional timestamps for the same content — a slide the group returned to is usually one they argued about, and it is worth a Screen Content line at the offset it came back, not just when it first appeared.
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
- If `autoStopped` is true: "The recording stopped on its own — [autoStopReason] — and hasn't been transcribed yet. Run `/meetey stop` to write it up." Say this rather than "no recording active"; the audio is sitting there unprocessed and the user almost certainly wants it.
- If `startedBy` is `watch`, the meeting watcher started it after the user confirmed — say "Recording [windowTitle], started by the meeting watcher." `/meetey stop` works on it normally.
- If inactive: "No recording active."

This is about the *live* recording only. For the health of the install, use `/meetey doctor`.

---

## `/meetey list [filters]`

Browse the library. Call `list_recordings`, mapping whatever the user gave you onto its
arguments — flags (`--since 2026-07-01`, `--until`, `--video`, `--audio-only`,
`--quality poor`, `--limit 10`) or plain language ("last week", "the ones with slides",
"anything that transcribed badly"). Resolve relative dates against today before calling.

Render one row per meeting, newest first:

```
Date          Title                      Duration  Quality  Screen  Size
2026-08-01    Q3 Roadmap and API Cutover  45 min    good     24 kf   118 MB
2026-07-30    Standup                     11 min    fair     —       28 MB
```

- Print the `sessionId` only when the user will need it next — it's noise otherwise, and
  `/meetey show` takes a date.
- When `limit` truncated the results, say what the full match count was. Never let a
  capped list read as the whole library.
- Empty library → "No recordings yet. Run `/meetey start` during your next meeting."
- Empty *because of the filters* → say which filter excluded everything and what the
  unfiltered count is, so the user can tell "no poor recordings" from "no recordings".

---

## `/meetey show <session-id | date | title words>`

Call `get_recording` with `sessionId` when the user gave one, otherwise `date`.

- Ambiguous date (several meetings that day) → the tool can't pick; list that day's
  meetings and ask which.
- Title words rather than a date → call `list_recordings` first, match on title, then
  fetch by `sessionId`.
- No argument at all → show the three most recent via `list_recordings` and ask.

Print the notes markdown as returned. It is already the finished document — do not
re-summarize it, and do not print the transcript. Follow with the artifact paths:

> Transcript: `<path>` · Audio: `<path>` · Keyframes: `<framesDir>`

---

## `/meetey search <query>`

Call `search_recordings`. `--notes` or `--transcripts` set `scope`; default is `all`.

Group matches by meeting and keep the `[mm:ss]` on every line — landing the user on the
moment is the entire point of the tool:

```
Q3 Roadmap and API Cutover — 2026-08-01
  [12:04]  Ship v1.1 without the motion heuristic; revisit next cycle
  [31:17]  Draft the migration doc — Priya · due Friday
```

- A match with no offset (a notes heading, front matter) prints without the timestamp
  rather than with a fabricated one.
- No matches → say so and give the scope that was searched, since `--notes` searching
  only decisions and action items is a common reason for a miss.

---

## `/meetey delete <session-id>`

Destructive and irreversible. `delete_recording` is dry-run unless `confirm: true`, and
that default exists to force this sequence — follow it exactly:

1. Call `delete_recording` with the `sessionId` and **no** `confirm`.
2. Show the user the exact file list it reports, with the total size.
3. Ask for confirmation in plain terms: "Delete these N files (X MB)? This cannot be undone."
4. Only after the user agrees, call again with `confirm: true`.

Never pass `confirm: true` in the same turn the user asked to delete, even if they said
"delete it and don't ask" — they haven't seen the file list yet, and the list is the
thing being confirmed.

`--keep-notes` sets `keepNotes: true`, removing the audio and keyframes but leaving the
notes and transcript. Offer it when the recording is large and the notes are `good`
quality: the WAV is nearly all of the disk, and the notes are the part worth keeping.

Deleting keyframes makes any screen-content claim in the notes unverifiable. Say so when
the session has frames and the user is not using `--keep-notes`.

---

## `/meetey watch`

Turns the meeting watcher on and off. The watcher is a background agent that notices
meetings in Chrome, Zoom, and Teams and **asks** before recording — it never starts a
recording on its own, and it records audio only.

- `/meetey watch` with no argument → `watcher_status`. Report whether it is on, in one
  line. If it is on, mention that it asks before recording; the user should not have to
  wonder whether something is being captured silently.
- `/meetey watch on` → `enable_watcher`. Say what it will now do, and that `/meetey watch off`
  reverses it.
- `/meetey watch off` → `disable_watcher`. Add that a recording already in progress keeps
  running — turning the watcher off is not stopping a capture, and someone doing this
  mid-meeting will assume otherwise.
- `/meetey watch log` → `watcher_log`. Use this when the watcher is on but never seems to
  ask: the log distinguishes "noticed nothing" from "could not list windows", and the
  second means node is missing Screen Recording permission.

**Only enable it when asked.** It installs a login agent that persists across restarts,
so it is not something to switch on helpfully because a user just missed a recording —
offer it, and let them answer. Turning it *off* on request needs no such hesitation.

Say plainly what it does not do: it does not detect that a *call* ended. A recording stops
when the app quits or the captured window closes, not when a meeting wraps up while the
app stays open.

---

## `/meetey doctor`

Call `system_status` and report the install's health.

- Everything healthy → one line per check, then the library's disk usage. Keep it short.
- Anything failing → lead with the failures and the fix for each, and put the passing
  checks in a single summary line underneath. A user runs this because something is
  broken; the working parts are not the answer.
- Map failures to the Troubleshooting table below rather than inventing new advice.

Missing Screen Recording permission is the one worth calling out specifically: it produces
a silent or empty recording rather than an error, so it is the likeliest cause of a
"meetey recorded nothing" complaint.

If asked about recording meetings automatically, describe what actually exists: an
optional watcher (`meetey watch enable` in a terminal) that notices meetings in Chrome,
Zoom, and Teams and **asks** before recording, audio only. It is off until enabled and
never records on its own. Do not describe it as detecting when a meeting *ends* — a
recording stops when the app quits or the captured window closes, not when a call wraps
up while the app stays open.

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
| Too many near-identical keyframes | Pass a higher `sceneThreshold` to `start_recording` (default 12). Narrowing to one window with `windowID` usually helps more, since it removes the app's other windows from the frame |
| Keyframes captured only from part of the meeting | Screen capture picks one window or display for the whole session. If the meeting moved to another window or screen, re-record with the right `windowID`/`displayID` |
| Keyframes missing a slide that was on screen | Lower `sceneThreshold`. A slide differing by only a word or two moves few enough grid cells to fall under the default |
