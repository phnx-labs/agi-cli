<!-- guide -->
# Subagents

Lightweight named agent definitions that parent agents can spawn for focused subtasks.

## Overview

A subagent is a directory in `~/.agents/subagents/<name>/` containing an `AGENT.md` file with YAML frontmatter and an instruction body. Parent agents whose capability matrix declares `subagents` (see `capableAgents('subagents')` in `src/lib/capabilities.ts` — today Claude, Codex, Cursor, OpenCode, OpenClaw, Copilot, Goose, Antigravity, Grok, Kimi, and Droid) discover installed subagents and can spawn them using their native task-dispatch mechanism (e.g., Claude's `Task()` tool). Each subagent definition specifies a model, a display color, and a focused instruction set. The resource resolution order is `project > user > system`, matching every other resource kind.

Subagents are one of three patterns for specialization. Plugins can bundle subagent definitions alongside skills and hooks. Workflows declare `allowedAgents` in their frontmatter to constrain which subagents the orchestrator can reach. In all cases the on-disk format is the same `AGENT.md` file.

**How an agent's subagents are stored is declared once, declaratively.** Two things gate a subagent integration: the `subagents` capability flag on `AgentConfig` (`src/lib/agents.ts`) is the *version gate*, and a single entry in the **subagent-target registry** (`src/lib/subagents-registry.ts`, `SUBAGENT_TARGETS`) is the *shape* — target dir, file/dir layout, transform, ownership marker. All install / list / detect / orphan / remove logic is generic over that table, so adding a standard integration is one registry entry, not near-identical `else if (agent === '...')` arms across the writer, detector, and `subagents.ts`. A test pins `Object.keys(SUBAGENT_TARGETS)` to `capableAgents('subagents')` so the two can never drift.

For the sync model that governs how subagents reach version homes, see [resource-sync.md](resource-sync.md).

## Architecture

```
Central storage (project > user > system):
  ~/.agents/subagents/<name>/          User-scoped
  .agents/subagents/<name>/            Project-scoped
  ~/.agents/.system/subagents/<name>/  System-shipped

  <name>/
    AGENT.md                           Required: frontmatter + instruction body

                      agents subagents add / agents use
                     (generic engine iterates SUBAGENT_TARGETS)
                                  │
                                  ▼
  <version-home>/                    (target dir + shape per registry entry)
    .claude/agents/<name>.md         flat-file  (Claude flatten)          [Tier 1]
    .codex/agents/<name>.toml        flat-file  (Codex TOML)              [Tier 1]
    .cursor/agents/<name>.md         flat-file  (no color)                [Tier 1]
    .grok/agents/<name>.md           flat-file  (Claude-compatible)       [Tier 2]
    .factory/droids/<name>.md        flat-file  (Droid custom droid)      [Tier 2]
    .copilot/agents/<name>.agent.md  flat-file  (Copilot custom agent)    [Tier 2]
    .config/opencode/agents/<name>.md   flat-file (OpenCode)             [Tier 2]
    .config/goose/agents/<name>.yaml    flat-file (Goose recipe)         [Tier 3]
    .gemini/config/agents/<name>/agent.md   dir-file (Antigravity)       [Tier 3]
    .openclaw/<name>/AGENTS.md       dir-copy   (AGENT.md → AGENTS.md)    [Tier 2]
    .kimi-code/agents/<name>.md      flat-file  (Kimi, kimi-code >= 0.29.0)  [Tier 3]

                      Parent agent session (Claude example)
                                  │
                                  ▼
  Parent reads .claude/agents/*.md catalog
  Spawns subagent via Task() with subagent's model + instructions
  Subagent executes with its own focused instruction set
```

## Integration tiers

Not every "wire subagents for X" is worth equal effort. Integrations are tiered by
importance so a "wire X" ticket can be scoped by tier instead of treated
identically — the long tail should cost far less than the core.

| Tier | Agents | What it means for a "wire X" ticket |
|------|--------|-------------------------------------|
| **Tier 1 — core** | `claude`, `codex`, `cursor` | First-class. Full support; bespoke transform/format work where the native format demands it. New subagent capabilities land here first. |
| **Tier 2 — established** | `openclaw`, `grok`, `droid`, `copilot`, `opencode` | Supported, ride the generic registry path. A bespoke `transform` only where the on-disk format differs — never bespoke install/list/remove logic. |
| **Tier 3 — long-tail** | `goose`, `antigravity`, `kimi` | Config-only; spend the minimum. A new one is a single `SUBAGENT_TARGETS` entry. `kimi` is a plain `flatFile` writing Claude-shaped `<name>.md`; the pre-0.29.0 files agents-cli used to write there (a `<name>.yaml` + `<name>.system.md` pair and an `_agents-cli.yaml` index) are folded once by `migrateKimiSubagentsToMarkdown` in `lib/installations/migrate.ts`, never by the target. |

**Adding a standard integration (Tier 2/3) is one entry, not six edits.** Give the
agent a `subagents` gate in `src/lib/agents.ts`, add one entry to `SUBAGENT_TARGETS`
in `src/lib/subagents-registry.ts` via a layout builder (`flatFile` / `dirFile` /
`dirCopy`), and — only if the native format is bespoke — a
`transformSubagentFor<Agent>` in `src/lib/subagents.ts`. The staleness writer, the
detector, `listSubagentsForAgent`, `diffVersionSubagents`, and
`removeSubagentFromVersion` are all generic over the table, so they need no new
arm. The completeness test (`subagents-registry.test.ts`) fails if the capability
flag and the registry entry ever disagree.

## Command Reference

| Command | Description |
|---------|-------------|
| `agents subagents list` | Table of all installed subagents with sync status across agent versions |
| `agents subagents view [name]` | Details for one subagent: model, color, file list, sync status |
| `agents subagents add <source>` | Install from GitHub (`gh:user/repo`) or local path, sync to agent versions |
| `agents subagents remove [name]` | Delete from central storage and unsync from all agent versions |

### Options

| Command | Flag | Effect |
|---------|------|--------|
| `add` | `-a, --agents <list>` | Target specific agents or versions, comma-separated: `claude`, `openclaw`, `claude@2.1.141`, `claude@all` (omitted: prompts, or takes the defaults with `--yes`) |
| `add` | `--names <list>` | Install only these subagents from the source (comma-separated) |
| `add` | `-y, --yes` | Skip all prompts and confirmation |
| `remove` | `-y, --yes` | Skip confirmation prompt |

## AGENT.md Schema

The `AGENT.md` file uses YAML frontmatter followed by the instruction body. The frontmatter maps to `SubagentFrontmatter` in `src/lib/types.ts`.

```markdown
---
name: code-reviewer
description: Reads changed files and surfaces bugs, missing tests, and scope creep.
model: claude-opus-4-7
color: cyan
---

You are a focused code reviewer. Your job is to read the diff and the full
context of every changed file, then produce a structured review with:

- Critical: bugs, regressions, security issues (cite file:line)
- Concerns: scope creep, missing tests, architectural drift
- Verdict: Approve / Request changes / Comment

Do not modify any files. Do not commit. Read only.
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Canonical name; must match the directory name |
| `description` | string | yes | One-line shown in `agents subagents list` |
| `model` | string | no | Model to use when the subagent is spawned (e.g. `claude-opus-4-7`) |
| `color` | string | no | Terminal display color for the subagent badge |

Additional `.md` files in the same directory (e.g., `TOOLS.md`, `MEMORY.md`) are collected as supplementary context. All `.md` files in the directory are counted in the `files` field of `InstalledSubagent`.

## Recipes

**1. List installed subagents**

```bash
agents subagents list
```

**2. View details for one subagent**

```bash
agents subagents view code-reviewer
```

**3. Install from GitHub**

```bash
agents subagents add gh:team/subagents --agents claude,openclaw,cursor
```

**4. Install from a local directory**

The source must contain `subagents/*/AGENT.md` entries.

```bash
agents subagents add ~/my-subagents --agents claude
agents subagents add ~/my-subagents --yes
```

**5. Remove a subagent**

```bash
agents subagents remove code-reviewer
agents subagents remove code-reviewer --yes
```

## See Also

- [resource-sync.md](resource-sync.md) — resource resolution and sync to version homes
- [docs/plugins.md](plugins.md) — plugins that bundle subagent definitions alongside skills and hooks
- [docs/hooks.md](hooks.md) — hooks that fire on subagent lifecycle events
