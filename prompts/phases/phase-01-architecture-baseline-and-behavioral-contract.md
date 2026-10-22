# Phase 01: Architecture Baseline and Behavioral Contract

## Objective

Characterize current Meetey capture, transcription, watcher, library, session-state, screen-evidence and writeup behavior before changing architecture. Reconcile code behavior with README, PRODUCT and CLAUDE documentation, especially screen/window scoping. Add deterministic regression fixtures for stale PID, interrupted WAV/header repair, orphan transcript, watcher restart, back-to-back meetings and current library behavior.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Do not intentionally change product behavior. Treat executable behavior as evidence and document discrepancies instead of preserving false promises.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Finish with tests and `docs/HANDOFF_PHASE_1.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
