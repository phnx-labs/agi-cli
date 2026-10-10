<!-- guide -->
# LiteLLM Proxy

Generic LLM gateway that fronts 100+ providers behind a single OpenAI-style API, with an Anthropic-shaped pass-through for Claude Code clients.

## Quick start

```bash
agents harness add
# wizard: pick the litellm preset, fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

## Required values

| Var | Where to get it |
|---|---|
| Proxy URL | Wherever you've deployed LiteLLM, e.g. `http://litellm.lan:4000` |
| Master / virtual key | LiteLLM `--master_key` or a virtual key minted via the admin UI |
| Model alias | The model name as defined in your `config.yaml` `model_list:` |

## Generated profile shape

```yaml
name: my-profile
host: { agent: claude }
env:
  # static vars (always set):
  ANTHROPIC_BASE_URL: http://litellm.lan:4000      # the Anthropic pass-through is at /v1/messages
  # vars wizard collects:
  ANTHROPIC_MODEL: claude-sonnet-4-5-bedrock
  ANTHROPIC_SMALL_FAST_MODEL: claude-haiku-4-5-bedrock
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.litellm.token
```

LiteLLM exposes both styles on the same port:

- OpenAI-style: `POST /v1/chat/completions`
- Anthropic pass-through: `POST /v1/messages`

Claude Code talks the Anthropic shape, so it lands on `/v1/messages` automatically when you set `ANTHROPIC_BASE_URL`.

## Known caveats

**Pass-through `tool_use` is historically flaky.** The `/v1/messages` adapter has had recurring issues round-tripping Anthropic `tool_use` blocks — tool calls sometimes arrive as raw text, or the model's `tool_result` payloads get reshaped on the way back. If tool calling matters for your workflow, prefer **vLLM's native Anthropic endpoint** (see [vllm.md](vllm.md)) over a LiteLLM hop.

**Drop unsupported params.** Upstreams reject fields they don't understand (e.g. `thinking`, `reasoning`, Anthropic beta cache controls). Configure LiteLLM to strip them in `config.yaml`:

```yaml
litellm_settings:
  drop_params: true
  additional_drop_params: ["thinking", "reasoning", "cache_control", "anthropic_beta"]
```

Without `drop_params: true` these surface as `400 Bad Request` from the upstream and Claude Code retries the whole request loop.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tool calls degrade to plain text | LiteLLM Anthropic pass-through adapter `tool_use` bug | Use vLLM's native Anthropic endpoint instead — see [vllm.md](vllm.md) |
| `400 Bad Request: unknown parameter 'thinking'` (or similar) | Upstream doesn't accept Anthropic-only fields | Add `drop_params: true` and the field to `additional_drop_params` |
| 401 / `Invalid proxy server token` | Wrong master/virtual key | `agents accounts set-key litellm` to rotate |
| `Model ... not in model_list` | Profile's `ANTHROPIC_MODEL` doesn't match any alias in `config.yaml` | Use the exact alias from your LiteLLM `model_list:` |
