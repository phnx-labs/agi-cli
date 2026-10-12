<!-- guide -->
# TrueFoundry

TrueFoundry LLM Gateway — a corporate gateway that forwards Anthropic-shaped requests to upstream providers (most commonly AWS Bedrock-hosted Claude).

> **Not to be confused with…** Microsoft Azure AI **Foundry** is a different product. See [foundry.md](foundry.md).

## Quick start

```bash
agents harness add
# wizard: pick the truefoundry preset, fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

## Required values

| Var | Where to get it |
|---|---|
| Gateway base URL | Your TrueFoundry workspace, e.g. `https://llm-gateway.<tenant>.truefoundry.tech/api/llm/anthropic` |
| Model id | TrueFoundry model catalog — format `<provider-account>/<model-id>`, e.g. `bedrock-prod/anthropic.claude-sonnet-4-20250514-v1:0` |
| API token | TrueFoundry → Settings → Personal Access Tokens |

## Generated profile shape

```yaml
name: my-profile
host: { agent: claude }
env:
  # static vars (always set):
  ANTHROPIC_BASE_URL: https://llm-gateway.<tenant>.truefoundry.tech/api/llm/anthropic
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1"
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0"
  DISABLE_PROMPT_CACHING: "1"
  # vars wizard collects:
  ANTHROPIC_MODEL: bedrock-prod/anthropic.claude-sonnet-4-20250514-v1:0
  ANTHROPIC_SMALL_FAST_MODEL: bedrock-prod/anthropic.claude-haiku-4-5-20251001-v1:0
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.truefoundry.token
```

## Known caveats

**Bedrock strict validation — "extra inputs are not permitted".** TrueFoundry forwards your request body to AWS Bedrock. Bedrock runs a strict Pydantic validator on the inbound payload and rejects experimental fields Claude Code adds (e.g. context-management, beta cache controls, attribution headers). The error surfaces as:

```
extra inputs are not permitted
```

The fix is three env vars that suppress those fields at the source:

```
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0
DISABLE_PROMPT_CACHING=1
```

Claude Code `>= 2.1.140` is known to send fields that older Bedrock validators reject — these three env vars suppress them. Downgrading the CLI is a fallback only, not the right fix.

**Self-signed / corporate CA chain.** Intra-cluster TrueFoundry gateways often present a corporate root CA your Node TLS store doesn't trust. For a trusted intra-cluster gateway it is acceptable to set:

```
NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Warn:** never set `NODE_TLS_REJECT_UNAUTHORIZED=0` against public hosts — it disables certificate validation globally for the process and exposes you to MITM. Use it only for an internal gateway you control. The right long-term fix is to add the corporate CA bundle to `NODE_EXTRA_CA_CERTS`.

**Model id format.** TrueFoundry expects `<provider-account>/<model-id>` (e.g. `bedrock-prod/anthropic.claude-sonnet-4-20250514-v1:0`), not the bare Anthropic model name (`claude-sonnet-4-5`). Look up the exact id in the TrueFoundry model catalog.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `extra inputs are not permitted` | Bedrock validator rejecting Claude Code experimental fields forwarded by the gateway | Set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, `DISABLE_PROMPT_CACHING=1` |
| `self signed certificate in certificate chain` / `unable to verify the first certificate` | Corporate CA not in Node's trust store | Add the CA bundle via `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`; for a trusted intra-cluster gateway `NODE_TLS_REJECT_UNAUTHORIZED=0` is acceptable |
| `model not found` / 404 | Wrong model id format | Use `<provider-account>/<model-id>` from the TrueFoundry catalog, not the raw Anthropic name |
| 401 / 403 | Token expired or wrong scope | `agents accounts set-key truefoundry` to rotate |
