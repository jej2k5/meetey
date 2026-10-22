# Phase 12: Portable Meeting Runtime

## Objective

Implement a transport-neutral DelegateRuntime with discover, prepare, join, identify, attend, leave and finalize lifecycle plus a MeetingAdapter contract. Keep platform-specific behavior outside the runtime.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Runtime code must not assume Zoom, Teams, Meet, AppleScript, browser DOM or macOS UI mechanics.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_12.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
