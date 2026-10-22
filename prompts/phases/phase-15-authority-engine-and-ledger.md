# Phase 15: Authority Engine and Authority Ledger

## Objective

Implement deterministic authority evaluation and an append-only Authority Ledger recording participant request, interpretation, applicable policy, knowledge access decision, disclosure decision, action/commitment decision, response and evidence.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

The model may interpret a request but may never grant itself authority. Unknown or ambiguous authority fails closed or escalates.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_15.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
