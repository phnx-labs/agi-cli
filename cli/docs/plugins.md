<!-- guide -->
# Plugins

Distributable bundles that package skills, commands, hooks, MCP servers, and permissions under a single versioned manifest.

## Overview

A plugin is a directory in `~/.agents/plugins/` containing a `.claude-plugin/plugin.json` manifest. When you install or sync a plugin, agents-cli copies its contents into a synthetic per-user marketplace inside the agent version home and enables it via `enabledPlugins` in `settings.json`. Plugins are a superset of individual resources: a single plugin can ship skills, slash commands, subagent definitions, hooks, MCP servers, LSP servers, monitors, bin scripts, and permission sets — installed atomically as a unit.

Only agents with `plugins: true` (or a version-gated `since`) in the capability matrix participate — today Claude, OpenClaw, Antigravity, Grok, Kimi, Cursor, Goose, Droid, and Codex >= 0.128.0 (`capableAgents('plugins')` in `src/lib/agents.ts`). Plugins can narrow further by declaring `agents: [...]` in their manifest. Plugins that ship executable surfaces (hooks, `.mcp.json`, `bin/`, `scripts/`, `settings.json`, `permissions/`) require explicit consent via `--allow-exec-surfaces` to be enabled after installation.

For the layered resource model that governs plugin resolution, see [resource-sync.md](resource-sync.md).

## Architecture

```
~/.agents/plugins/<name>/             Central source (user-authored, git-tracked)
  .claude-plugin/
    plugin.json                       Required manifest: name, version, description
  skills/<skill>/SKILL.md             Slash-command knowledge packs
  commands/*.md                       Slash commands (converted to skills on Codex >= 0.117.0)
  agents/*.md                         Subagent definitions
  hooks/hooks.json         ◄ exec     Hook registrations — triggers exec-surface gate
  .mcp.json                ◄ exec     MCP server declarations
  bin/                     ◄ exec     Executable binaries
  scripts/                 ◄ exec     Arbitrary shell scripts
  settings.json            ◄ exec     Agent settings merge (non-permissions keys)
  permissions/             ◄ exec     Permission group YAML files
  .user-config.json                   Per-install user config values (runtime, not shipped)
  .source                             Git remote recorded at install time

                                      On agents sync --plugin / install
                                               │
                                               ▼
<version-home>/.claude/
  plugins/
    known_marketplaces.json           "agents-cli" → marketplaces/agents-cli  (registered)
    marketplaces/agents-cli/
      .claude-plugin/marketplace.json Lists every discovered plugin
      plugins/<name>/                 Copy of source (user-config placeholders resolved)
    settings.json
      enabledPlugins["<name>@agents-cli"] = true   (only when exec gate passes)
```

## Command Reference

| Command | Description |
|---------|-------------|
| `agents plugins list` | Table view of all plugins with sync status across agent versions |
| `agents plugins view <name>` | Metadata, resources, and installation status for one plugin |
| `agents plugins info <name>` | Alias for `view` |
| `agents plugins add <spec>` | Install from a git URL or local path |
| `agents plugins install <spec>` | Alias for `add` |
| `agents install plugin:<spec>` | Same install path (Phase 5 umbrella); same `--allow-exec-surfaces` gate |
| `agents plugins update [name]` | Re-pull from original source and re-sync (all plugins if no name given) |
| `agents sync --plugin <name> [agent]` | Apply a plugin to an agent (all supported agents if none given) |
| `agents plugins remove [name]` | Unsync from all agent versions; optionally delete source directory |

### Options

| Command | Flag | Effect |
|---------|------|--------|
| `add` | `--allow-exec-surfaces` | Enable the plugin even when it ships hooks, MCP, bin, scripts, settings, or permissions |
| `sync` | `--allow-exec-surfaces` | Same gate override for the sync path |
| `remove` | `--keep-source` | Unsync from agents but leave `~/.agents/plugins/<name>/` on disk |

## Manifest Schema

`.claude-plugin/plugin.json` is the required entry point. Every field maps directly to `PluginManifest` in `src/lib/types.ts:378`.

```json
{
  "name": "git",
  "version": "1.0.0",
  "description": "Git workflow commands — atomic grouped commits and merged-branch cleanup.",
  "agents": ["claude", "openclaw"],
  "dependencies": ["other-plugin"],
  "userConfig": [
    {
      "key": "api_url",
      "description": "Base URL for the API",
      "required": true,
      "default": "https://api.example.com"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Plugin identifier; must match the directory name |
| `version` | string | yes | SemVer string shown in `agents plugins list` |
| `description` | string | yes | One-line description |
| `agents` | `AgentId[]` | no | Limit to specific agents; omit to support all capable agents |
| `dependencies` | `string[]` | no | Other plugin names required; missing deps produce a warning at install |
| `userConfig` | `PluginUserConfigField[]` | no | Interactive fields prompted at install time; values stored in `.user-config.json` |

### Directory Layout

```
my-plugin/
  .claude-plugin/
    plugin.json         # Required manifest
  skills/
    my-skill/
      SKILL.md          # Skill definition
  commands/
    my-command.md       # Slash command
  agents/
    my-subagent.md      # Subagent definition
  hooks/
    hooks.json          # Hook registrations (exec surface)
  .mcp.json             # MCP server config (exec surface)
  bin/
    my-binary           # Executable (exec surface)
  scripts/
    setup.sh            # Setup scripts (exec surface)
  settings.json         # Settings to merge (exec surface)
  permissions/
    my-perms.yaml       # Permission group (exec surface)
```

## Exec-Surface Consent Gate

Plugins that ship any of `hooks/`, `.mcp.json`, `bin/`, `scripts/`, a non-permissions `settings.json`, or `permissions/` are **installed** (copied to the marketplace) but **not enabled** unless you pass `--allow-exec-surfaces`.

The gate is implemented at `src/commands/plugins.ts:68`:

```typescript
export function shouldRefusePluginInstall(
  capabilities: PluginCapabilities,
  allowExecSurfaces: boolean
): boolean {
  return hasPluginExecSurfaces(capabilities) && !allowExecSurfaces;
}
```

`PluginCapabilities` maps each surface to a boolean flag (`hasHooks`, `hasMcp`, `hasBin`, `hasScripts`, `hasSettings`, `hasPermissions`). `hasPluginExecSurfaces()` returns true if any flag is true.

Without the flag, the plugin is placed in the marketplace and listed in `known_marketplaces.json`, but `enabledPlugins["<name>@agents-cli"]` is never set to `true` in `settings.json`. The plugin is present but inert until you re-run with consent.

This prevents automated sync flows (`agents use claude@<v>`) from silently activating third-party code that runs shell scripts or registers MCP servers in every new session.

## Recipes

**1. Install a plugin from GitHub**

```bash
agents plugins add rush-toolkit@https://github.com/user/rush-toolkit.git

# If the plugin ships hooks or MCP and you trust the source:
agents plugins add rush-toolkit@https://github.com/user/rush-toolkit.git --allow-exec-surfaces
```

**2. Install from a local path**

```bash
agents plugins add ~/Projects/my-plugin
# or with an explicit name:
agents plugins add rush-toolkit@~/Projects/rush-toolkit
```

**3. Sync after pulling the repo**

```bash
# After git pull or manual edits to ~/.agents/plugins/my-plugin/:
agents sync --plugin my-plugin
agents sync --plugin my-plugin claude --allow-exec-surfaces
```

**4. List what is installed and enabled**

```bash
agents plugins list
agents plugins view rush-toolkit
```

**5. Remove a plugin**

```bash
# Remove from all agents and delete source:
agents plugins remove rush-toolkit

# Unsync only, keep source directory:
agents plugins remove rush-toolkit --keep-source
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/plugins.mp4"></video>

## See Also

- [resource-sync.md](resource-sync.md) — how plugins participate in the layered resource sync model
- [docs/subagents.md](subagents.md) — subagent definitions that plugins can bundle
- [docs/hooks.md](hooks.md) — hook manifests that plugins can ship
- docs/workflows.md — workflow bundles that can reference plugins
