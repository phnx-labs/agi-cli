<!-- guide -->
# Self-hosted vLLM

Run an open-weight model on your own GPUs and point Claude Code at it via vLLM's **native Anthropic endpoint**.

## Quick start

```bash
# 1. Start vLLM with the native Anthropic entrypoint
python -m vllm.entrypoints.anthropic \
  --model Qwen/Qwen3-Coder-30B-A3B-Instruct \
  --tool-call-parser hermes \
  --enable-expert-parallel

# 2. Create the profile
agents harness add
# wizard: pick the vllm preset, fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

Reference: https://docs.vllm.ai/en/stable/serving/integrations/claude_code/

## Required values

| Var | Where to get it |
|---|---|
| Endpoint | The host:port vLLM is bound to, e.g. `http://gpu-box.lan:8000` |
| Model id | The model you passed to `--model` (vLLM echoes the same id back) |
| API key | Whatever you set via `--api-key`; can be a dummy string like `EMPTY` for trusted networks |

## Generated profile shape

```yaml
name: my-profile
host: { agent: claude }
env:
  # static vars (always set):
  # (none — vLLM's native Anthropic endpoint needs no transport flags)
  # vars wizard collects:
  ANTHROPIC_BASE_URL: http://gpu-box.lan:8000
  ANTHROPIC_MODEL: Qwen/Qwen3-Coder-30B-A3B-Instruct
  ANTHROPIC_SMALL_FAST_MODEL: Qwen/Qwen3-Coder-30B-A3B-Instruct
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.vllm.token
```

## Known caveats

**Use the native Anthropic endpoint.** Prefer `python -m vllm.entrypoints.anthropic` over vLLM's OpenAI-compatible endpoint plus a translation shim — the native path round-trips `tool_use` blocks cleanly. The OpenAI translation path drops or mangles tool calls in both directions, which makes Claude Code's tool loop unreliable.

**Tool-call parser must match the model.** `--tool-call-parser hermes` works for Qwen-Coder. If tool calls come back as raw text instead of structured `tool_use`, try `--tool-call-parser qwen` or `--tool-call-parser llama3_json`. The parser name is per-model; consult the vLLM docs.

**MoE models need expert parallelism.** For mixture-of-experts models like `Qwen3-Coder-30B-A3B`, add `--enable-expert-parallel` or you'll leave most of the model's throughput on the table.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tool calls arrive as plain text instead of `tool_use` blocks | Wrong `--tool-call-parser` for the model | Switch to `hermes` / `qwen` / `llama3_json` to match the model family |
| Stalls or OOM on MoE model | Expert parallelism disabled | Add `--enable-expert-parallel` |
| 404 on `/v1/messages` | Started the OpenAI endpoint, not the Anthropic one | Re-launch with `vllm.entrypoints.anthropic` |
| 401 from Claude Code | vLLM was started with `--api-key` and the profile's keychain entry doesn't match | Re-run `agents accounts set-key vllm` with the same value you passed to `--api-key` |
