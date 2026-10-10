<!-- guide -->
# DeepInfra

DeepInfra exposes an OpenAI-compatible API. The built-in `deepinfra` profile runs it through Codex and reads its API key from a durable account bundle with secrets policy `never`, so headless runs do not request Touch ID.

## Quick start

```bash
agents accounts add deepinfra --provider deepinfra --auth api-key
agents harness add deepinfra --account deepinfra
agents run deepinfra "summarize this repository"
```

Create an API key at <https://deepinfra.com/dash/api_keys>. The generated profile uses:

```yaml
name: deepinfra
host: { agent: codex }
env:
  OPENAI_BASE_URL: https://api.deepinfra.com/v1/openai
  OPENAI_MODEL: deepseek-ai/DeepSeek-V3
account: deepinfra             # the durable account name, not a per-device id
provider: deepinfra
```

Use another model by forking the profile and changing its model:

```bash
agents harness fork deepinfra deepinfra-model \
  --model <deepinfra-model-id> \
  --account deepinfra
```

`agents view` reads DeepInfra's documented `/payment/checklist` endpoint through the daemon-owned BYOK refresh path. It renders current usage against the configured spending limit, or available prepaid credit when the account has no limit.
