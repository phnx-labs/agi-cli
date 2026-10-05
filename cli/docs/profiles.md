<!-- guide -->
# Profiles

> **Surface note:** the top-level `agents profiles` command was removed.
> Use `agents harness add|fork|edit|list|view|remove`. Provider API keys are
> accounts: `agents accounts add|set-key|remove` (RUSH-2981 removed
> `agents harness login|logout`).
> Profile YAML under `~/.agents/profiles/` is unchanged.


Named bundles of host CLI, endpoint, model, and a durable account reference — run alternative providers through a standard agent interface without a local proxy.

## Overview

A profile pins a host agent binary to a non-default API endpoint and model. Its `account:` field stores the durable account **name** — portable across devices, since profiles sync fleet-wide with `agents repo push` while account ids are minted per-machine; the credential stays in the device keychain. Running `agents run <profile>` resolves the account at spawn time, injects the provider-specific environment, and fails before spawning if the credential is absent. A dangling ref (the account doesn't exist on this device) names the harness and the `agents harness edit <name> --account <name>` repair.

A custom harness runs anywhere an agent name is accepted, not just `agents run`: as a teammate (`agents teams add <team> deepseek "…"`), in a routine (`agents routines add --agent deepseek`), and on another machine (`agents run deepseek --device <box>` — the profile must exist on the target, which `agents repo push user` handles). Routines delegate the job to `agents run <name>`; the profile pins its own host version and auth, so `@version` pins, balanced rotation, and account failover don't apply to those jobs.

Built-in presets cover the top open-weight models via OpenRouter (one shared key) and native CLI providers (xAI, Google). Custom profiles work with any OpenAI-compatible endpoint: Ollama, vLLM, LiteLLM Proxy. Profile YAML files live under `~/.agents/profiles/` and are resolved by name at `agents run` time.

> **Status:** Profiles are experimental, but available by default — no enable step needed.

## Custom harnesses (`agents harness`)

A custom harness is a profile you create from a host CLI + model in one command, so a model like Meta Muse Spark 1.1 runs like a native agent type:

```sh
# OpenCode pinned to Muse Spark, named `spark`
agents harness add spark --host opencode --model meta/muse-spark-1.1
agents run spark "refactor api/handlers/checkout.py"

# per-run model override still wins over the profile
agents run spark --model opencode/big-pickle "quick pass"

# private OpenAI/Anthropic-compatible endpoint using an existing account
agents harness add corp --host claude --model gpt-x --base-url https://gw.corp/v1 --account corp
```

The model is written to the host's model env var — `OPENCODE_MODEL` for opencode, `ANTHROPIC_MODEL` for claude, `GROK_MODEL` for grok, `GEMINI_MODEL` for gemini. Native OAuth remains harness-managed; omit `--account` to use that login.

`agents harness list` shows three groups: your custom harnesses, the addable built-in presets, and the native harness registry. `agents harness view <name>` and `agents harness remove <name>` round it out.

A harness *is* a profile — same `~/.agents/profiles/<name>.yml`, same `agents run` resolution, same device sync via `agents repo push user`. The difference from `agents harness add`: `harness add` takes the host+model one-shot (no preset needed) and owns its own `--host` flag, whereas `agents harness --host <device>` is reserved for running the profiles command on a remote device.

### Forking a harness (`agents harness fork`)

`fork` is the one verb for both starting points — a native harness, or a custom one you already tuned:

```sh
# fork the native OpenCode harness onto a DeepSeek model, keyed by OpenRouter
agents harness fork opencode deepseek --model deepseek/deepseek-v4-flash-0731 --account openrouter-work

# fork Claude Code onto a private gateway
agents harness fork claude corp --model gpt-x --base-url https://gw.corp/v1 --account corp

# copy an existing harness and swap only the model
agents harness fork deepseek deepseek-chat --model deepseek/deepseek-chat-v3
```

Forking a **native** harness requires `--model` — there is no model to inherit. Forking a **custom** harness copies everything (env, endpoint, account binding, `fallback_model`, host version pin) and applies only the flags you pass; the two diverge from that point, so removing the source never affects the fork. `--force` overwrites an existing harness of the same name. The name `agents view` prints is derived from the harness `name` — `deepseek-flash` renders as `DeepSeek Flash` — so there is no flag to set it. The fork records its parent as `forkedFrom:` in the YAML — display-only lineage.

### Editing and renaming a harness (`agents harness edit` / `rename`)

`edit` applies overrides onto an existing harness **in place** — same name, same lineage — instead of copying it under a new one:

```sh
# swap the pinned model
agents harness edit deepseek --model deepseek/deepseek-v3.2

# attach a different durable account
agents harness edit corp --account corp2

# unpin the host CLI version
agents harness edit spark --version ""

# add (or clear, with an empty string) a same-host fallback model for rate-limit retries
agents harness edit deepseek --fallback-model deepseek/deepseek-chat-v3
```

`edit` takes the same override flags as `fork` (`--model`, `--base-url`, `--account`, `--version`, `--description`) plus one edit-only flag, `--fallback-model`, for `Profile.fallback_model` (see [`routines.md`](routines.md) and the fallback cascade in `runWithFallback`). Unlike `fork`, `edit` never rewrites `forkedFrom` to point at itself.

Giving zero flags **in a terminal** now opens the same interactive wizard `add`/`fork` use, pre-filled with the harness's current values (`agents harness edit deepseek` with no flags). It walks each editable field — model, endpoint, auth, version, fallback, description — and writes only what you change; leaving every prompt at its default is a no-op. Fields the host can't carry are shown disabled with a reason: a host with no custom-endpoint slot (anything but claude/codex) skips the base-URL prompt, and a self-updating host (grok/droid/antigravity/cursor/hermes/muse/goose) skips the version pin, rather than silently accepting a value a run would drop. Giving zero flags **without** a terminal stays a no-op error naming the available ones, so scripts are unchanged.

`agents harness rename <old-name> <new-name>` renames the underlying YAML file and updates the `name:` field inside it; every other harness whose `forkedFrom:` pointed at the old name is rewritten to the new one. Renaming onto an existing name is a hard error — there is no overwrite path (use `remove` first if that's really the intent).

### Importing a key from an existing secrets bundle

Accounts own credentials; harnesses only reference accounts. Import an existing secret while creating the account, then attach that account wherever it is needed:

```sh
agents accounts add corp --provider proxy --auth api-key --from-secrets prod:OPENROUTER_KEY
agents harness add corp-model --host claude --model gpt-x --base-url https://gw.corp/v1 --account corp
agents accounts set-key corp --from-secrets prod:OPENROUTER_KEY
```

### Interactive wizard (`agents harness add` / `fork` / `edit`)

Run `add` or `fork` in a terminal without enough flags to build a harness (e.g. bare `agents harness add`, or `agents harness fork claude` with no `--model`) and a picker walks you through it instead of throwing: fork from (every native host plus your existing harnesses) → a built-in preset or "build custom" (host + model + provider) → the model → the endpoint (only when the host carries one) → the harness's name (pre-filled with the preset's own name, e.g. `deepseek`, not a model detail) → the account. `edit` opens the same wizard pre-filled with a harness's current values when you run it with no flags (see above). Flags remain fully supported for scripts — the wizard only engages when required info is missing **and** stdin+stdout are a TTY; a non-interactive shell still gets the original error.

**Model is a catalog pick, not free text.** When the host exposes a model catalog (`getModelCatalog` — the same list behind `agents models <host>`, covering claude/codex/gemini/opencode/cursor/openclaw/antigravity/kimi/grok), the model step is a `select` over its models with a tier/alias hint, plus a "type a custom model id…" escape hatch that is always present. A host with no probeable catalog falls back to the original free-text prompt, so nothing blocks.

**Endpoint is gated by the host's API format.** The base-URL step is prompted only for a host that actually carries a custom-endpoint slot (claude → `ANTHROPIC_BASE_URL`, codex → `OPENAI_BASE_URL`); every other host shows the field disabled with a one-line reason instead of silently accepting a value a run would drop. The edit wizard applies the same **per-host editability matrix** (`harnessEditable`, sourced entirely from the resolver maps so it can never drift from what a run honors): endpoint disabled off claude/codex, version pin disabled for self-updating hosts (grok/droid/antigravity/cursor/hermes/muse/goose), model/auth/fallback/description editable per the host's own env keys.

**Pre-save connection test.** After configuring — create or edit — the wizard runs a real minimal request through the same path a run takes (`agents run <name> "say alive in one word" --headless --timeout 60s` → `resolveProfileForRun` → `resolveProfileEnv` → `buildExecEnv` → spawn) and reports the outcome, classifying a failure as an **auth** rejection (401 / invalid key), an **endpoint** problem (DNS / connection), or a **model** the endpoint doesn't serve. It is behind a confirm (default yes) and the `--test` / `--no-test` flags force or skip it; a non-interactive caller (`--key-stdin`, no TTY) skips it unless `--test` is given. A failed test never silently blocks the save — on a terminal it offers **keep it / edit it now / delete and cancel**, so a harness pointed at a temporarily-down endpoint can still be saved on purpose. In a **non-interactive** shell a `--test` failure warns and keeps the harness (exit 0, with a "fix and retest with `agents harness edit <name>`" hint) rather than failing the command — the test is a validation aid, not a hard CI gate.

All flows drive one shared step engine ([`src/commands/harness-wizard.ts`](../src/commands/harness-wizard.ts)): a `create` and an `edit` step list over a single runner, each step skippable by the matching flag and gated by a `WizardIO` seam that makes the engine testable without a TTY. The model catalog, connection test, and per-host edit matrix plug into it via typed extension points (`WizardHooks`, implemented in [`src/commands/harness-hooks.ts`](../src/commands/harness-hooks.ts) and [`src/lib/harness-connection-test.ts`](../src/lib/harness-connection-test.ts)).

### Custom harnesses are their own agent type

`agents view` lists each custom harness as its own block, beside Claude and Codex rather than indented under whichever host CLI executes it — because `agents run <name>` already launches it the same way a native agent id is launched:

```
  deepseek-flash (custom)
    deepseek/deepseek-v4-flash-0731  openrouter stored  via claude

  deepseek-chat (custom · forked from deepseek-flash)
    deepseek/deepseek-chat-v3        openrouter stored  via claude
```

The row carries the pinned model, the account/auth state, and `via <host>` — the native harness that actually runs it, with its version when the harness pins one. A harness whose host CLI has no install is flagged `(host <id> not installed)` rather than listed as runnable. `agents view <name>` describes one harness (host, model, provider, auth, lineage, YAML path), and `agents view <name> --json` emits its summary. A native-specific `agents view <agent>` shows only that native harness's versions; it does not include custom harnesses that execute through it. The exact custom name also wins in `agents run`, before native ids and hard-deprecated aliases, so the fork remains runnable through its configured host. The unfiltered `agents view --json` inventory keeps hosted summaries under the `harnesses` key for machine consumers.

## Architecture

```
~/.agents/
  profiles/
    kimi.yml              # profile YAML (no secrets)
    deepseek.yml
    local-llama.yml

macOS Keychain
  agents-cli.openrouter.token    # shared across all openrouter profiles
  agents-cli.xai.token           # xAI profiles
  agents-cli.ollama.token        # custom profiles

                  ┌─────────────────────┐
  agents run kimi │  resolveProfileEnv  │
  ───────────────▶│  1. read kimi.yml   │
                  │  2. read Keychain   │──▶ spawn claude
                  │  3. merge env block │     ANTHROPIC_BASE_URL=...
                  └─────────────────────┘     ANTHROPIC_MODEL=...
                                              ANTHROPIC_AUTH_TOKEN=<key>
```

Profile YAML `host.agent` selects which binary is spawned. Env vars override defaults for that CLI. Auth is resolved last — keychain item name is stored in `auth.keychainItem` and the env var to inject it under is stored in `auth.envVar`.

## Command Reference

| Command | Description | Example |
|---------|-------------|---------|
| `harness list` / `ls` | List configured profiles (name, host, provider, model) | `agents harness list` |
| `harness list` | List custom harnesses and the built-in presets | `agents harness list` |
| `harness view <name>` / `show` | Inspect a profile (env vars, auth status, preset link) | `agents harness view kimi` |
| `harness add <name>` | Add a profile from a preset. Prompts for API key once per provider. | `agents harness add kimi` |
| `harness add <name> --preset <preset>` | Add a profile using an explicit preset name | `agents harness add k2 --preset kimi` |
| `harness add <name> --version <v>` | Pin the host CLI version | `agents harness add kimi --version 2.1.113` |
| `harness add <name> --key-stdin` | Read API key from stdin (CI-safe) | `echo $KEY \| agents harness add kimi --key-stdin` |
| `harness add <name> --force` | Overwrite an existing profile | `agents harness add kimi --force` |
| `harness add\|fork\|edit … --test` / `--no-test` | Force / skip the pre-save connection test (default: ask on a terminal) | `agents harness add spark --host opencode --model m --test` |
| `harness remove <name>` / `rm` | Delete a profile (keychain token is kept) | `agents harness remove kimi` |
| `accounts add <name>` | Store a provider API key as a durable account | `agents accounts add openrouter --provider openrouter --auth api-key` |
| `accounts set-key <name>` | Rotate an account credential (or `--from-secrets bundle:key` for CI) | `agents accounts set-key openrouter` |
| `accounts remove <name>` | Remove an account and its device-local credential | `agents accounts remove openrouter` |

## Built-in Presets

All OpenRouter presets share one key (`agents-cli.openrouter.token`). Adding a second OpenRouter preset never re-prompts.

| Preset | Provider | Model | Notes |
|--------|----------|-------|-------|
| `kimi` | openrouter | `moonshotai/kimi-k2.5` | 99% HumanEval. REASONING — interactive only; `--print` returns empty output. |
| `kimi-chat` | openrouter | `moonshotai/kimi-k2-0905` | Non-reasoning sibling. PRINT-SAFE. |
| `minimax` | openrouter | `minimax/minimax-m2.5` | 80.2% SWE-bench. REASONING — interactive only. |
| `glm` | openrouter | `z-ai/glm-5` | #1 Chatbot Arena ELO among open-weight. REASONING — interactive only. |
| `qwen` | openrouter | `qwen/qwen3-coder-next` | Latest coding Qwen. PRINT-SAFE. |
| `deepseek` | openrouter | `deepseek/deepseek-chat-v3-0324` | Non-reasoning DeepSeek Chat. PRINT-SAFE. |
| `open-claude` | openrouter | `qwen/qwen3-coder-next` | Open-weight coding inside Claude Code — general open-claude path. PRINT-SAFE. |
| `claude-spark` | openrouter | `meta/claude-spark-1.1` | Meta Claude Spark 1.1 via OpenRouter inside Claude Code. Open alternative for open-claude spark usage. |
| `opencode` | opencode | (default) | OpenCode default — uses configured model. Auth via `opencode auth`. |
| `opencode-spark` | opencode | `meta/claude-spark-1.1` | Meta Claude Spark 1.1 via OpenCode — best for open-claude usage with opencode harness. |
| `opencode-qwen` | opencode | `qwen/qwen3-coder-next` | Qwen3 Coder Next via OpenCode — free via opencode provider. |
| `grok-fast` | xai | `grok-build-fast` | Native grok host. |
| `grok-heavy` | xai | `grok-build` | Native grok host (SuperGrok). |
| `agy` | google | (CLI default) | Native antigravity host. |
| `anthropic` | anthropic | `claude-3-5-sonnet-latest` | Direct Anthropic API. |
| `deepinfra` | deepinfra | `deepseek-ai/DeepSeek-V3` | DeepInfra's OpenAI-compatible API through Codex. |
| `proxy` | proxy | (custom) | Generic local proxy / gateway. |
| `truefoundry` | truefoundry | (custom) | TrueFoundry AI Gateway. |
| `bedrock` | bedrock | (custom) | AWS Bedrock native mode. |
| `vertex` | vertex | (custom) | Google Vertex AI. |
| `foundry` | foundry | (custom) | Azure AI Foundry. |
| `litellm` | litellm | (custom) | LiteLLM proxy. |
| `vllm` | vllm | (custom) | Self-hosted vLLM. |
| `ollama` | ollama | `qwen3-coder:30b` (default) | Local Ollama via Codex host. |

Source: `src/lib/profiles-presets.ts`.

**REASONING vs PRINT-SAFE:** Claude Code sends `thinking:{type:"enabled"}` in its Anthropic payload. When the model returns reasoning/redacted_thinking blocks, `--print` consolidation returns empty stdout. Reasoning presets (`kimi`, `minimax`, `glm`) work fine interactively; use print-safe variants (`kimi-chat`, `qwen`, `deepseek`) for `agents run --print` and scripted pipelines.

## Configuration Schema

```yaml
# ~/.agents/profiles/<name>.yml

name: local-llama              # string, required — must match filename stem
                               # Pattern: [a-z0-9][a-z0-9-_]{0,48} (case-insensitive)

description: Local Llama 3.3  # string, optional — shown in `harness list` and `view`

host:
  agent: claude                # AgentId, required — which CLI binary to spawn
                               # One of: claude, codex, cursor, opencode, grok, antigravity
                               # (gemini is hard-deprecated — see concepts.md)
  version: 2.1.113             # string, optional — pin this host CLI version

env:                           # Record<string, string>, required (may be empty {})
  ANTHROPIC_BASE_URL: http://localhost:11434   # endpoint override
  ANTHROPIC_MODEL: llama-3.3-70b              # model override
  ANTHROPIC_SMALL_FAST_MODEL: llama-3.3-70b  # fast-path model (optional)

auth:                          # optional — omit if no token is needed
  envVar: ANTHROPIC_AUTH_TOKEN # string — which env var to inject the key into
  keychainItem: agents-cli.ollama.token  # string — keychain item that holds the key

preset: kimi                   # string, optional — preset this profile was created from
                               # Set automatically by `harness add`; informational only.

provider: openrouter           # string, optional — provider name for display
                               # Set automatically by `harness add`; informational only.

models:                        # Partial<Record<ModelTier, string>>, optional
  cheap: deepseek/deepseek-chat-v3        # per-tier model ids for THIS harness's
  default: deepseek/deepseek-v4-flash-0731 # own catalog — resolves `agents run
  best: deepseek/deepseek-r1               # <profile> --model cheap|default|best|ultra`
                               # against the harness's own models instead of the host
                               # agent's (claude/codex/...) native catalog. An unset
                               # tier clamps to the next CHEAPER tier that IS set
                               # (ultra -> best -> default -> cheap). Omit entirely to
                               # keep today's behavior: a requested tier falls back to
                               # the single pinned model in `env`, unchanged.
```

Fields sourced from `Profile` interface at `src/lib/profiles.ts:19-73`.

## Recipes

### 1. Add a preset and run it

```bash
# Store the OpenRouter key once (all openrouter presets reuse it)
agents accounts add openrouter --provider openrouter --auth api-key

# Add Kimi (interactive use — reasoning model)
agents harness add kimi
agents run kimi "refactor the auth handler"

# Add a print-safe preset for scripted use
agents harness add deepseek
agents run deepseek --print "summarize the diff"
```

### 2. Write a custom YAML for a local Ollama endpoint

Drop a YAML under `~/.agents/profiles/local-llama.yml`:

```yaml
name: local-llama
description: Local Llama 3.3 via Ollama
host:
  agent: claude
env:
  ANTHROPIC_BASE_URL: http://localhost:11434
  ANTHROPIC_MODEL: llama-3.3-70b
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.ollama.token
```

Then store the key and verify:

```bash
agents accounts add ollama --provider ollama --auth api-key    # or: echo "your-key" | agents harness add local-llama --key-stdin
agents harness view local-llama
agents run local-llama "hello"
```

### 3. Rotate the API key for a provider

Rotation applies to all profiles that share the same provider key:

```bash
agents accounts set-key openrouter   # prompts for new key, overwrites the old one
# All kimi, kimi-chat, minimax, glm, qwen, deepseek profiles pick it up immediately
```

To rotate non-interactively (CI), import from an `agents secrets` entry:

```bash
agents accounts set-key openrouter --from-secrets openrouter.ai:OPENROUTER_API_KEY
```

### 4. List and inspect configured profiles

```bash
agents harness list              # table: NAME HOST PROVIDER MODEL
agents harness view kimi         # env vars, auth status, signup URL
agents harness presets           # full preset catalog with descriptions
```

### 5. Pin a specific host version

```bash
agents harness add kimi --version 2.1.113
# spawns claude@2.1.113 for this profile only
```

### 6. Remove a profile without losing the key

```bash
agents harness remove kimi
# YAML deleted; agents-cli.openrouter.token stays in Keychain
# Other openrouter profiles are unaffected

# To fully remove the key too:
agents accounts remove openrouter
```

### 7. Run a profile on a leased box

```bash
agents run deepseek "summarize this repo" --lease hetzner
agents run deepseek "summarize this repo" --box warm-one
```

Leased profile runs install the profile's `host.agent` on the disposable box and
materialize a temporary profile there for the duration of the run. Profiles with
their own API key, such as OpenRouter-backed `kimi` and `deepseek`, ship that
profile auth only; the base runtime's local OAuth credential is copied only when
the profile has no auth env of its own. `--box <slug>` targets an existing warm
crabbox box instead of provisioning a disposable lease, so the same box can serve
profile runs from different repositories and remains running after the command.

`--lease` is reuse-first against one shared `default` pool across repositories:
before leasing a new box it looks for a warm box with the same network mode that
`crabbox status` reports SSH-ready, and reuses it instead of paying for one warm
box per repo. If the pool is empty, the newly warmed box is kept after the run so
the next caller can reuse it. Each concurrent run copies the synced checkout into its own
`~/workspaces/<repo>-<run>` directory, then launches there; callers share compute,
not a working tree, agent home, or credential file. Switching repositories therefore pays a re-sync latency in
exchange for the lower idle-compute cost.

The generic `.crabbox.yaml` `profile:` key still scopes repo sandbox/CI scripts.
To opt `agents run --lease` into a dedicated hot-box pool, add a separate lease
label explicitly:

```yaml
leaseProfile: private-hot-box
```

`--fresh` opts out of reuse entirely: it always provisions a brand-new box and
tears it down after the run.

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/profiles.mp4"></video>

`agents harness add kimi` stores the OpenRouter key once; `agents run kimi` spawns Claude Code with Kimi K2.5 responding.

## See Also

- `docs/concepts.md` — DotAgents repos, resource resolution order
- `docs/resource-sync.md` — how profiles sync across machines
- `docs/secrets.md` — inject secrets bundles into agent runs

## Per-provider guides

For non-preset providers (gateways, self-hosted), the wizard at `agents harness add` walks you through the env vars. Per-provider gotchas are in:

- [TrueFoundry](profiles/truefoundry.md) — LLM Gateway, Bedrock-backed
- [AWS Bedrock](profiles/bedrock.md) — direct
- [Google Vertex](profiles/vertex.md)
- [Microsoft Azure AI Foundry](profiles/foundry.md) — distinct from TrueFoundry
- [OpenRouter](profiles/openrouter.md) — built-in presets
- [DeepInfra](profiles/deepinfra.md) — built-in Codex preset with a durable provider account
- [Self-hosted vLLM](profiles/vllm.md) — native Anthropic endpoint, tool_use clean
- [LiteLLM Proxy](profiles/litellm.md)
- [Ollama](profiles/ollama.md) — Codex host recommended

Full table: [profiles/INDEX.md](profiles/INDEX.md).
