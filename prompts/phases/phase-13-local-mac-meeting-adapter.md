# Phase 13: Local Mac Meeting Adapter

## Objective

Implement the first MeetingAdapter for the local Mac environment using existing Meetey capture and meeting-detection capabilities where safe. Isolate platform mechanics behind the adapter contract.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Preserve current capture reliability. Adapter failure must not corrupt evidence or strand runtime state.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_13.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
