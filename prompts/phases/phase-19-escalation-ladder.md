# Phase 19: Escalation Ladder

## Objective

Implement Act -> Ask principal -> Defer -> Capture for follow-up. Select behavior from authority, confidence, urgency, mission policy and principal reachability. Escalations must carry concise decision context and preserve the eventual response in the ledger.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Unreachable principal never expands authority. Time pressure never converts missing permission into permission.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_19.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
