<!-- guide -->
# AWS Bedrock

Direct AWS Bedrock — Claude Code talks to Bedrock's Anthropic endpoint without a gateway in front of it. For Bedrock fronted by TrueFoundry, see [truefoundry.md](truefoundry.md) instead.

## Quick start

```bash
agents harness add
# wizard: pick the bedrock preset, fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

## Required values

| Var | Where to get it |
|---|---|
| AWS region | The region where you've enabled the Claude model in Bedrock |
| Model id | Bedrock model catalog, e.g. `anthropic.claude-sonnet-4-20250514-v1:0` |
| Auth | Either `AWS_BEARER_TOKEN_BEDROCK` or the standard AWS SDK credential chain (env, profile, IMDS, SSO) |

## Generated profile shape

```yaml
name: my-profile
host: { agent: claude }
env:
  # static vars (always set):
  CLAUDE_CODE_USE_BEDROCK: "1"
  # vars wizard collects:
  AWS_REGION: us-west-2
  ANTHROPIC_MODEL: anthropic.claude-sonnet-4-20250514-v1:0
  ANTHROPIC_SMALL_FAST_MODEL: anthropic.claude-haiku-4-5-20251001-v1:0
auth:
  envVar: AWS_BEARER_TOKEN_BEDROCK
  keychainItem: agents-cli.bedrock.token
```

If you'd rather use the AWS SDK credential chain (recommended for SSO/IAM Identity Center setups), omit the `auth:` block and let `aws sso login` populate the chain — Claude Code picks it up automatically when `CLAUDE_CODE_USE_BEDROCK=1` is set.

## Known caveats

**Strict request validation.** Bedrock runs a Pydantic validator on inbound payloads and rejects experimental fields Claude Code adds. If you see `extra inputs are not permitted`, set:

```
DISABLE_PROMPT_CACHING=1
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
CLAUDE_CODE_ATTRIBUTION_HEADER=0
```

The first one is the most common fix; the other two cover newer Claude Code releases.

**Model availability is region-specific.** Not every `claude-*` model is enabled in every region. Check the Bedrock model catalog for your region before pinning a model id — `anthropic.claude-opus-4-7-*` in particular rolls out gradually.

**Model id format.** Bedrock uses the `anthropic.claude-...-v1:0` form, not the bare `claude-sonnet-4-5` alias. Inference profile ARNs also work (`arn:aws:bedrock:<region>:<account>:inference-profile/...`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `extra inputs are not permitted` | Bedrock validator rejecting experimental fields | `DISABLE_PROMPT_CACHING=1` (plus the two `CLAUDE_CODE_*` flags if needed) |
| `AccessDeniedException` on model invoke | Model not enabled in this region/account | Enable the model in the Bedrock console, or pick a region where it's already enabled |
| `ValidationException: ... model identifier` | Wrong model id format | Use `anthropic.<model>-v1:0` or an inference profile ARN |
| `UnrecognizedClientException` / `InvalidSignatureException` | AWS credentials missing or stale | Refresh via `aws sso login`, or rotate `AWS_BEARER_TOKEN_BEDROCK` |
