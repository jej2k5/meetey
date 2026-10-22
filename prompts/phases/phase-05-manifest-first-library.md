# Phase 05: Manifest-First Library

## Objective

Refactor the meeting library to read authoritative manifests first while preserving legacy reconstruction as compatibility fallback. Preserve list/show/search/delete semantics unless an intentional contract change is documented and tested.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

No recording becomes undiscoverable because its manifest is absent, stale or partially written. Delete semantics remain explicit and safe.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Finish with tests and `docs/HANDOFF_PHASE_5.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
