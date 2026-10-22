# Phase 04: Evidence Object Model

## Objective

Implement typed evidence objects for transcript segments, screen observations, claims, decisions, actions and questions. Derived assertions must carry provenance to supporting source evidence and distinguish observed facts from inference.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Derived data is recomputable. Raw evidence is immutable. Provenance cannot be optional for claims, decisions or actions.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Finish with tests and `docs/HANDOFF_PHASE_4.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
