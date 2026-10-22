# Phase 11: Delegate Identity

## Objective

Implement a persistent AI delegate identity plus meeting-specific role/presentation such as observer or authorized participant. Make identity and role available to meeting adapters and audit records.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Meetey must never impersonate the human principal. Identity, role and current authority state must be distinguishable.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_11.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
