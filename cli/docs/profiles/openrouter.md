<!-- guide -->
# OpenRouter

Single API key, many open-weight models. `agents-cli` ships built-in OpenRouter presets so adding the second profile never re-prompts for a key.

## Quick start

```bash
agents harness add
# wizard: pick an OpenRouter preset (kimi-chat, qwen, ...), fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

Or use the built-in presets directly:

```bash
agents accounts add openrouter --provider openrouter --auth api-key   # store key once
agents harness add kimi                 # reasoning model, interactive
agents harness add kimi-chat            # non-reasoning sibling, print-safe
agents run kimi-chat "summarize the diff"   # a prompt runs headless
```

## Required values

| Var | Where to get it |
|---|---|
| API key | https://openrouter.ai/keys |
| Model id | https://openrouter.ai/models — `<vendor>/<model-slug>` |

## Generated profile shape

```yaml
name: my-profile
host: { agent: claude }
env:
  # static vars (always set):
  ANTHROPIC_BASE_URL: https://openrouter.ai/api/v1
  # vars wizard collects:
  ANTHROPIC_MODEL: moonshotai/kimi-k2-0905
  ANTHROPIC_SMALL_FAST_MODEL: moonshotai/kimi-k2-0905
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.openrouter.token
```

## Built-in presets

| Preset | Model | Notes |
|---|---|---|
| `kimi` | `moonshotai/kimi-k2.5` | Reasoning — interactive only. |
| `kimi-chat` | `moonshotai/kimi-k2-0905` | Non-reasoning sibling. Print-safe. |
| `minimax` | `minimax/minimax-m2.5` | Reasoning — interactive only. |
| `glm` | `z-ai/glm-5` | Reasoning — interactive only. |
| `qwen` | `qwen/qwen3-coder-next` | Latest coding Qwen. Print-safe. |
| `deepseek` | `deepseek/deepseek-chat-v3-0324` | Non-reasoning DeepSeek Chat. Print-safe. |

## Known caveats

**Print-safe vs reasoning models.** Claude Code's `--print` consolidator returns empty stdout when the response contains `thinking` or `redacted_thinking` blocks. That's why running a reasoning model (`kimi`, `minimax`, `glm`) headless (`agents run <profile> "<prompt>"`, which drives Claude Code's `--print`) looks "silent" — the model is replying, but its top-level blocks are reasoning, and the consolidator strips them.

The fix: use `kimi-chat` (non-reasoning) for scripting and pipelines, and `kimi` (reasoning) for interactive use. The same rule applies to any reasoning model you wire up manually — if `--print` returns empty, switch to a non-reasoning sibling.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| headless `agents run kimi "..."` prints nothing | Reasoning model; `--print` consolidator drops thinking blocks | Use `kimi-chat` (or any print-safe preset) for scripted use |
| 401 / `Invalid API key` | Stale or wrong key in Keychain | `agents accounts set-key openrouter` to rotate |
| `model not found` | Slug typo or model retired | Look up the current slug at openrouter.ai/models |
| 429 / rate limit | OpenRouter per-key cap | Add credits or slow down |
