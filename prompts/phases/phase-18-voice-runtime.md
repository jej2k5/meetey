# Phase 18: Voice Runtime

## Objective

Introduce a provider-neutral voice runtime for speech generation, microphone/audio routing, interruption handling, turn taking and speaking-state management. Keep generated speech separate from delegate reasoning and authority.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Voice cannot bypass participation or authority gates. Speaking identity must remain explicit.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_18.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
