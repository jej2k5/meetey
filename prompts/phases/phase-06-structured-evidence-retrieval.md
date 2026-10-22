# Phase 06: Structured Evidence Retrieval

## Objective

Add deterministic retrieval over meetings, time, evidence type, participant, topic, decision, action and provenance. Keep text search as a supported primitive but stop treating substring matching as the product retrieval model.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Do not add embeddings or a vector database in this phase. Retrieval must return source references suitable for later reasoning.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Finish with tests and `docs/HANDOFF_PHASE_6.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
