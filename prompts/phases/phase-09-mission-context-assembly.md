# Phase 09: Mission Context Assembly

## Objective

Build provenance-preserving context assembly for proposed missions from authorized sources. Start with Meetey history and explicit context interfaces while defining adapter boundaries for calendar, email, repositories and knowledge systems.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Context access is scoped. Retrieval permission does not imply disclosure or action permission. Do not tightly couple the mission engine to a provider.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_9.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
