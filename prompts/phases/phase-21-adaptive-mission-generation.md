# Phase 21: Adaptive Mission Generation

## Objective

Generate proposed missions from meeting class, participants, agenda, prior evidence and authorized context. Provide a human-readable explanation of intended outcome, requested access and proposed authority.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Generated missions are proposals. They cannot self-approve or silently expand authority.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_21.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
