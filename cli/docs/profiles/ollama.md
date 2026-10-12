<!-- guide -->
# Ollama

Local models served by Ollama on `127.0.0.1:11434`. **Recommended host: `codex`**, not Claude Code.

## Quick start

```bash
ollama serve &
ollama pull qwen3-coder:30b

agents harness add
# wizard: pick the ollama preset, fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

## Required values

| Var | Where to get it |
|---|---|
| Endpoint | Defaults to `http://127.0.0.1:11434/v1` for the OpenAI-compatible API |
| Model id | Whatever you've pulled, e.g. `qwen3-coder:30b` |
| API key | Ollama doesn't require one — pass any non-empty string (`ollama`) |

## Generated profile shape

```yaml
name: my-profile
host: { agent: codex }                     # Codex is OpenAI-native; talks to Ollama without a shim
env:
  # static vars (always set):
  OPENAI_BASE_URL: http://127.0.0.1:11434/v1
  # vars wizard collects:
  OPENAI_MODEL: qwen3-coder:30b
auth:
  envVar: OPENAI_API_KEY
  keychainItem: agents-cli.ollama.token
```

## Known caveats

**Use the Codex host, not Claude Code.** Codex speaks OpenAI natively, which is the shape Ollama serves on `/v1`. Pointing Claude Code at Ollama requires a translation shim (CCR, LiteLLM, anyclaude) that converts Anthropic ↔ OpenAI — and every shim available today drops the `tools` array on the way through, breaking the tool_use round-trip. Use Codex and skip the shim.

**Known-working model.** `qwen3-coder:30b` works well end-to-end on Apple Silicon with Codex as the host. Other coding models work too — `deepseek-coder-v2`, `qwen2.5-coder` — but tool-call quality is model-dependent at this size.

**Ollama doesn't authenticate, but Codex demands a key.** Set `OPENAI_API_KEY` to any non-empty string (the keychain entry can be literally `ollama`). The value never leaves your machine.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tool calls silently ignored | Using Claude Code with an Anthropic→OpenAI translation shim (CCR / LiteLLM / anyclaude) | Switch the profile's `host.agent` to `codex` |
| `connection refused` on `127.0.0.1:11434` | `ollama serve` not running | Start the daemon, or `brew services start ollama` |
| Model spins for minutes before first token | Model isn't loaded into memory yet | First request always pays the cold-start cost; subsequent runs are fast |
| `model 'X' not found` | Model not pulled | `ollama pull <model>` |
