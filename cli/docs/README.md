# Architecture and decisions

This directory has two layers: **decision docs** (how agents-cli works and which
choices must survive a refactor) and **guides** (how-to references for each subsystem).
Use `agents <group> --help` or the generated [command index](command-index.md) for exact
syntax, and the product README for onboarding.

Read the decision docs in this order:

1. [Architecture](architecture.md) — ownership and process boundaries.
2. [Concepts](concepts.md) — the domain model and vocabulary.
3. [Resources](resources.md) and [execution](execution.md) — inputs and the one launch path.
4. [Sessions](sessions.md), [fleet](fleet.md), and [orchestration](orchestration.md).
5. [Automation](automation.md), [interfaces](interfaces.md), and [secrets](secrets.md).
6. [Observability](observability.md), [share](share.md), [distribution](distribution.md),
   [behavioral specifications](specifications.md), and [benchmarks](benchmarks.md)
   (measured numbers; not Linear).

Decision docs contain boundaries, owners, data flow, state transitions, invariants,
failure behavior, and accepted tradeoffs — not walkthroughs or recipes.

## Guides (how-to)

Subsystem references, complementary to the decision docs above. Restored after an
over-aggressive docs sweep removed them (2026-08-25); kept concise.

- Execution & fleet: [ssh-transport](ssh-transport.md), [hosts](hosts.md),
  [version-management](version-management.md), [resource-sync](resource-sync.md),
  [self-healing](self-healing.md)
- Tools: [browser](browser.md), [computer](computer.md)
- Orchestration: [teams](teams.md), [routines](routines.md), [monitors](monitors.md),
  [cloud](cloud.md)
- Resources: [hooks](hooks.md), [subagents](subagents.md), [plugins](plugins.md),
  [profiles](profiles.md) (+ [profiles/](profiles/INDEX.md))
- State & security: [secrets-agent-process-model](secrets-agent-process-model.md),
  [secrets-trust-boundaries](secrets-trust-boundaries.md),
  [credential-management](credential-management.md), [projects](projects.md),
  [watchdog](watchdog.md), [menubar](menubar.md), [terminal-engine](terminal-engine.md)

## Audits

- [surface-census](surface-census.md) (rendered: [surface-census.html](surface-census.html)) —
  2026-09-06 census of every command group: non-test lines, subcommand count, real usage
  across 10,173 session transcripts, 90-day churn, and a keep / merge / extract / cut verdict
  per group. Re-run the measurements before acting on a number older than a release.

`command-index.md`, `command-index.json`, and `command-reference.html` are generated
from the Commander tree. Never edit them by hand.
