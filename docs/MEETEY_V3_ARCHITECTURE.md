# Meetey V3 Architecture

## Product direction
Meetey evolves from local meeting recorder to a local evidence layer and progressively delegated meeting representative.

## Core model
Identity + Mission + Authority + Evidence + Context -> Delegated Participation.

Permission is three-dimensional: may access, may disclose, may act. None implies another.

## Release progression
- V3.0 Evidence Foundation: phases 1-7.
- V3.1 Delegate Observer: phases 8-14.
- V3.2 Supervised Participant: phases 15-19.
- V3.3 Adaptive Delegate: phases 20-24.

## Non-negotiable invariants
1. Meetey never impersonates the principal.
2. Raw evidence is local-first, durable and not rewritten by derived processing.
3. Derived claims retain provenance to evidence.
4. The model may interpret requests but cannot grant itself authority.
5. Access permission does not imply disclosure permission. Disclosure permission does not imply action permission.
6. Unknown authority fails closed or escalates.
7. Autonomy is scoped progressive delegation, never a global mode.
8. Meeting/platform specifics live behind adapters.
9. UI or platform failure must not corrupt capture/evidence.
10. Every consequential delegate decision must be replayable from policy, context and evidence.

## Trust gates
Phase 7: recorder -> evidence system.
Phase 14: evidence system -> unattended attendee.
Phase 19: attendee -> supervised representative.
Phase 24: supervised representative -> adaptive delegate.
