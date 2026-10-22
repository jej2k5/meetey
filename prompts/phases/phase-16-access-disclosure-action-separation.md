# Phase 16: Access, Disclosure and Action Separation

## Objective

Enforce independent may_access, may_disclose and may_act decisions across delegate context, participation and actions. Add adversarial tests proving that permission in one dimension never implies another.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Default deny. Sensitive accessible context must remain undisclosed unless disclosure is separately authorized.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_16.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
