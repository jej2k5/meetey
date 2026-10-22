# Phase 03: Legacy Manifest Reconstruction

## Objective

Implement deterministic, idempotent reconstruction of manifests for legacy WAVs, transcripts, notes, frame directories and front matter. Surface uncertainty instead of inventing metadata.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Never rewrite, rename, delete or reinterpret raw legacy evidence. Re-running reconstruction produces equivalent manifests.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Finish with tests and `docs/HANDOFF_PHASE_3.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
