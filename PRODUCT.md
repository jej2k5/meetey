# Product

## Register

product

## Platform

macos

Outside this skill's `web` / `ios` / `android` / `adaptive` set, recorded accurately
rather than forced into a wrong fit. The UI surfaces are AppKit menu bar extras and
AppleScript alerts; Apple's HIG for macOS menu bar extras and alerts is the
applicable rulebook, not iOS conventions.

## Users

People who sit in video calls on a Mac and use Claude Code — the same person is the
operator and the audience. They are mid-meeting when they touch this: on a laptop,
in a call, attention already spent, glancing at the top-right corner of the screen
between sentences. Nobody opens Meetey; it is already running or it isn't. The job
is "capture this conversation so I don't have to take notes", and the moments of
interaction are two — agreeing to record, and ending it.

A meaningful second audience is in the room but never at the keyboard: the other
people on the call, who are being recorded and cannot see the interface. Their
interests are represented only by how visible and honest the operator's UI is.

## Product Purpose

Meetey captures meeting audio locally, transcribes it with whisper.cpp on-device,
and has Claude write structured notes where every decision and action item carries
the timestamp it came from. Recording and transcription never leave the machine;
the transcript text does go to the API, and the docs say so plainly.

Success is a meeting that produces checkable notes without anyone having thought
about the tool during it — and, equally, a person who at any moment during that
meeting can tell at a glance exactly what is being captured.

## Positioning

Meeting notes you can check, from a recorder that never joins your call — no bot,
no cloud transcription, and nothing recorded that you weren't asked about first.

## Brand Personality

Plain-spoken, exact, and unwilling to overstate. The product's own documentation
refuses to describe features as more capable than they are — auto-stop is
documented as *not* meeting detection, the watcher is described by what it will not
do before what it will. That restraint is the personality: an instrument that
reports its state accurately and never performs confidence it hasn't earned.

Quiet by default, legible on demand. Nothing celebratory, nothing reassuring for
its own sake.

## Anti-references

- **Zoom's floating meeting controls.** Draggable, many buttons, always in the way.
  Recording control is one action, not a control panel.
- **Consumer recorder apps** (Otter, Granola-style): dashboards in a popover,
  onboarding, upsells, streak counters, anything selling itself back to the user.
- **Silent system utilities.** The opposite failure: a background process with no
  visible state, where the only way to know it is running is to go looking. For a
  thing that records people, invisibility is a defect, not restraint.
- **Confirmation theatre.** "Are you sure you want to stop?" Stopping is expected
  and non-destructive; asking twice is noise dressed as care.

## Design Principles

- **Consent is a state, not a moment.** A prompt is a single instant; recording
  lasts an hour. Whatever is capturing must stay visible and identifiable for the
  whole time it runs, without being clicked.
- **Say what is actually being captured.** Audio-only and audio-plus-screen are
  materially different things to consent to, and must never look identical.
- **Never perform a capability the tool doesn't have.** If it cannot tell that a
  call ended, it must not imply it can. Honest limits beat confident guesses.
- **One action, no ceremony.** The interface exists to end a recording. Everything
  else on it is a readout.
- **Failing to show up must never take the recording down.** The indicator is
  subordinate to the capture; a missing GUI session loses the UI, not the audio.

## Accessibility & Inclusion

WCAG AA for any text surface. Colour must never be the only carrier of state —
the recording indicator's red is a reinforcement of a shape and a label, never the
signal itself, which also protects it against menu bar tinting and colour-blind
users. Status items need accurate VoiceOver labels that describe state ("Recording,
audio only, 12 minutes"), not just a control name. Alerts must be dismissible by
keyboard, and a prompt nobody answered is never treated as consent.
