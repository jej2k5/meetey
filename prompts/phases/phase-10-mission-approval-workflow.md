# Phase 10: Mission Approval Workflow

## Objective

Implement draft, review, approve, modify, reject, revoke, active and completed mission lifecycle. At this release stage, unattended attendance requires an approved mission.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Approval must bind to the exact mission version and authority envelope. Changed authority invalidates prior approval.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_10.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
