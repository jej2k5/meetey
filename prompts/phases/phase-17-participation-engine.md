# Phase 17: Participation Engine

## Objective

Implement mission-oriented participation decisions: remain silent, answer, ask, clarify, propose, escalate or defer. Decisions must use mission state and authority outcomes and be auditable.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Optimize for meeting outcomes, not agent activity. Permission to speak does not create an obligation to speak.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_17.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
