# Phase 02: Meeting Manifest

## Objective

Introduce a versioned meeting manifest as the canonical durable representation of a meeting: identity, lifecycle, capture mode, source, timestamps, artifacts, provenance and derived-object references. New recordings must receive manifests through atomic/recoverable writes.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

Raw evidence remains independently usable. Schema evolution is explicit. A partial manifest write must not corrupt a recording.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Finish with tests and `docs/HANDOFF_PHASE_2.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
