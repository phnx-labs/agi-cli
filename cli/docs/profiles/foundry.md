<!-- guide -->
# Microsoft Azure AI Foundry

Anthropic models served through Microsoft Azure AI Foundry (formerly Azure AI Studio).

> **Not to be confused with TrueFoundry.** Microsoft Azure AI Foundry and TrueFoundry are different products with overlapping names. TrueFoundry → [docs/profiles/truefoundry.md](truefoundry.md).

## Quick start

```bash
agents harness add
# wizard: pick the foundry preset, fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

## Required values

| Var | Where to get it |
|---|---|
| Resource name | The Foundry resource name in the Azure portal (the prefix in `<resource>.services.ai.azure.com`) |
| API key | Azure portal → your Foundry resource → Keys and Endpoint |
| Model deployment id | Foundry → Deployments — must be a Claude deployment |

## Generated profile shape

```yaml
name: my-profile
host: { agent: claude }
env:
  # static vars (always set):
  CLAUDE_CODE_USE_FOUNDRY: "1"
  # vars wizard collects:
  ANTHROPIC_BASE_URL: https://<resource>.services.ai.azure.com/anthropic
  ANTHROPIC_MODEL: claude-sonnet-4-5
  ANTHROPIC_SMALL_FAST_MODEL: claude-haiku-4-5
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.foundry.token
```

The base URL pattern is `<resource>.services.ai.azure.com/anthropic` — note the `/anthropic` suffix that routes to the Anthropic-shaped endpoint.

## Known caveats

**Foundry env vars intermittently ignored.** Known issue [claude-code#11937](https://github.com/anthropics/claude-code/issues/11937) — in some Claude Code releases `CLAUDE_CODE_USE_FOUNDRY=1` is not consistently honored and the CLI falls back to direct Anthropic. If you see requests going to `api.anthropic.com` despite the var being set, pin Claude Code to a release where the integration is stable (check the issue for the current good version).

**Same Bedrock-style strict validation risk.** If Foundry's upstream is configured to relay to Bedrock, you can hit the same `extra inputs are not permitted` error documented in [truefoundry.md](truefoundry.md). The same three suppressor env vars apply.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Requests still hit `api.anthropic.com` | claude-code#11937 — Foundry env vars not picked up | Pin a Claude Code version that honors `CLAUDE_CODE_USE_FOUNDRY=1`; verify with `--debug` |
| 404 on `/anthropic` path | Base URL missing the `/anthropic` suffix | Set `ANTHROPIC_BASE_URL=https://<resource>.services.ai.azure.com/anthropic` exactly |
| 401 / 403 | Wrong key or key from a different Foundry resource | Rotate via `agents accounts set-key foundry` |
| `extra inputs are not permitted` | Upstream Bedrock validator (Foundry-relayed) | Apply the `DISABLE_PROMPT_CACHING=1` + `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` + `CLAUDE_CODE_ATTRIBUTION_HEADER=0` triplet |
