# Design decisions

The owner's standing product and design calls for `agents`. A cleanup, a refactor,
or an automated simplification pass reads this file first and treats every entry
as a constraint, not a suggestion. A smaller or more uniform design is not a reason
to override one; changing an entry is an owner decision, recorded here in the same
PR that acts on it.

Why this exists: automated passes optimize for fewer lines and fewer concepts, and
that pressure removes things the owner chose on purpose. It has happened: the
how-to guides in this directory were deleted by an over-aggressive docs sweep on
2026-08-25 and restored on 2026-08-28.

## Kept on purpose

| Decision | What it rules out | Where it lives |
|---|---|---|
| `-D, --device <name>` is the one routing flag for running a command on another machine | Renaming it to `--host`, or adding `--host` as an alias. `--host` is rejected on purpose (`cli/src/lib/hosts/option.test.ts`); the standalone engines take `--host`, and `agents` rewrites `--device` to it at that boundary | `cli/src/lib/hosts/option.ts`, `cli/src/commands/secrets-passthrough.ts`, `cli/src/lib/computer-client.ts` |
| `agents feed` stays a first-class group: `feed watch --json` is the operator stream AGI EXT and AGI Menu consume, and `feed post`/`answer` are how agents reach the owner | Folding it into `sessions`, or deleting it as "UI plumbing" | `cli/AGENTS.md` §feed, `cli/src/lib/feed/` |
| Noun-then-verb command shape, `--json` on every data command, and `examples` in help for non-trivial commands | Flattening verbs to the top level or trimming help to save lines | root `AGENTS.md` §CLI surface conventions |
| `update` stays available but hidden while version pinning is phased out | Deleting it because it is unadvertised | `cli/docs/surface-census.md` (2026-09-06) |
| One scheduler and one executor (the daemon) for anything that acts on the fleet | Moving a timer or action loop into a UI surface | `cli/docs/specifications.md` §Scheduling & execution singularity |
| Credentials are keyed on device role; a headed box never falls back to the setup-token | A "native login expired, use the token" fallback | `cli/docs/credential-management.md` invariant 7 |
| CI and release latency bars R1-R5 | Raising a bar or adding a helper rebuild to the CLI release | root `AGENTS.md` §OWNER REQUIREMENTS |
| The comment ceiling in `scripts/comment-budget.json` only goes down | Raising it to fit a change | `scripts/comment-lines.ts` |

## Removed on purpose

Do not reintroduce these, and do not "restore" them as a cleanup.

| Removed | Replacement | Record |
|---|---|---|
| `agents hosts` | `agents devices` (`ps`, `stop`, `run`, `add`) | `cli/src/lib/startup/command-registry.test.ts` |
| `agents monitors` | none | PHNX-4241 |
| `agents humans`, `reminders`, `modes`, `feedback`, `restore` | the account owner path; `trash restore` | PHNX-4267, `RETIRED_TOP_LEVEL_COMMANDS` |
| `agents artifacts` and the share Worker | the standalone `artifacts` CLI | PHNX-3992 |
| Installing `gemini` | `antigravity` | `cli/AGENTS.md` §Supported harnesses |

## Decided, not yet removed

These are owner decisions whose code still exists. Carrying them out is a planned
change with its own PR, never a side effect of a cleanup.

| Decision | Current state | Record |
|---|---|---|
| `trace` and `traces` stop being top-level nouns: the daemon captures and uploads | both still registered; `traces` code is the evals capture seam and stays | `cli/docs/surface-census.md` (2026-09-06) |
| `search` is cut because `sessions` owns search | still registered | `cli/docs/surface-census.md` (2026-09-06) |

## What an automated simplification pass may change

Allowed without asking, one small PR at a time, behavior preserved and the generated
command reference unchanged (`cli/scripts/generate-reference.sh --check` exits 0):

- delete a file or export that has no production caller (check runtime registration,
  dynamic `import()`, `cli/scripts/` and `packages/` before calling it dead);
- fold a duplicate helper into the owner that already exists for it;
- replace hand-written code with a Node built-in or a dependency already in
  `cli/package.json`, when behavior is equivalent;
- move per-harness branches into the registry that already models that capability.

Never without an owner decision recorded here first:

- remove or rename a command, subcommand, flag, alias, config key or `--json` field;
- change user-visible text, defaults or output format;
- remove a feature because it looks unused, small, or awkward;
- retire a migration or compatibility path.

Those go to the owner as a proposal, not a PR. [`cli/HEALTH.md`](../HEALTH.md) separates
the two kinds: its "Owner decisions" table is not a work queue.
