# Phase 22: Bounded Autonomous Participation

## Objective

Allow explicitly trusted meeting classes to operate without per-meeting approval while retaining deterministic effective delegation from class, mission, identity, access, disclosure, action and escalation policy.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Do not implement a global autonomous=true switch. Autonomy is scoped delegation and remains revocable.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_22.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
