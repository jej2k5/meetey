# Phase 20: Meeting Class Policies

## Objective

Introduce reusable meeting classes with default mission templates, knowledge/disclosure/action scopes and escalation policies. Individual meetings may narrow defaults.

## Global constraints

Before implementing, read README.md, docs/PRODUCT.md, CLAUDE.md, docs/MEETEY_V3_ARCHITECTURE.md, and the previous phase handoff.

Preserve Meetey's local-first posture, explicit recording/attendance disclosure, recoverable raw evidence, provenance, backward compatibility unless explicitly changed, and deterministic authorization boundaries. Prefer deterministic code for capture, storage, policy and authorization; use models for interpretation and reasoning only where appropriate.

A class is a policy template, not blanket autonomy. Meeting-specific policy can never silently broaden class authority.

Do not add unrelated product features, a dashboard, cloud transcription, or meeting-bot infrastructure outside this phase. Do not silently weaken consent, identity disclosure, evidence integrity, or authority boundaries.

Finish with tests and `docs/HANDOFF_PHASE_20.md` containing implementation summary, intentional omissions, tests run, decisions, known debt, files changed, and next action.
