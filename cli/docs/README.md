# Architecture and decisions

This directory explains how agents-cli works and which decisions must survive a
refactor. It is not a command manual. Use `agents --help` (start-here groups),
`agents --help --all` (every group), `agents <group> --help`, or the generated
[command index](command-index.md) for syntax, and the product README for onboarding.

Read in this order:

1. [Architecture](architecture.md) — ownership and process boundaries.
2. [Concepts](concepts.md) — the domain model and vocabulary.
3. [Resources](resources.md) and [execution](execution.md) — inputs and the one launch path.
4. [Sessions](sessions.md), [fleet](fleet.md), and [orchestration](orchestration.md).
5. [Automation](automation.md), [interfaces](interfaces.md), and [secrets](secrets.md).
6. [Observability](observability.md), [distribution](distribution.md),
   [behavioral specifications](specifications.md), and [benchmarks](benchmarks.md)
   (measured numbers; not Linear).

Authored documents contain boundaries, owners, data flow, state transitions,
invariants, failure behavior, and accepted tradeoffs. They do not contain setup
walkthroughs, exhaustive flags, recipes, file maps, key-function inventories,
ticket-era roadmaps, or mutable provider/model tables.

`command-index.md`, `command-index.json`, and `command-reference.html` are generated
from the Commander tree. Never edit them by hand.
