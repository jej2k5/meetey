# Phase 08: Meeting Mission Schema

## Objective

Introduce a versioned MeetingMission model covering objective, desired outcomes, agenda, delegate identity, knowledge scope, disclosure scope, authority envelope, escalation policy and meeting policy. Keep mission intent separate from the meeting manifest.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Mission describes why Meetey attends; Manifest describes what happened. Default authority is deny unless explicitly granted.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_8.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
