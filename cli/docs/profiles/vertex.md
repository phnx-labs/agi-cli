<!-- guide -->
# Google Vertex AI

Anthropic models served from Google Cloud Vertex AI.

## Quick start

```bash
agents harness add
# wizard: pick the vertex preset, fill the prompts, name it my-profile, run the connection test
agents run my-profile "hello"
```

## Required values

| Var | Where to get it |
|---|---|
| GCP project id | `gcloud config get-value project` |
| Region | A Vertex region where the model is available (e.g. `us-east5`, `europe-west1`) |
| Service-account key | GCP IAM → Service Accounts → Keys → JSON; path goes in `GOOGLE_APPLICATION_CREDENTIALS` |
| Model id | Vertex model garden, e.g. `claude-sonnet-4-5@20250929` |

## Generated profile shape

```yaml
name: my-profile
host: { agent: claude }
env:
  # static vars (always set):
  CLAUDE_CODE_USE_VERTEX: "1"
  # vars wizard collects:
  ANTHROPIC_VERTEX_PROJECT_ID: my-gcp-project
  CLOUD_ML_REGION: us-east5
  GOOGLE_APPLICATION_CREDENTIALS: /Users/me/.config/gcloud/vertex-sa.json
  ANTHROPIC_MODEL: claude-sonnet-4-5@20250929
  ANTHROPIC_SMALL_FAST_MODEL: claude-haiku-4-5@20251001
# no auth: block — Vertex uses GOOGLE_APPLICATION_CREDENTIALS, not a bearer token
```

## Known caveats

**Auth is a service-account JSON file, not a bearer token.** `GOOGLE_APPLICATION_CREDENTIALS` must be the **path** to a JSON key file on disk. There is no `ANTHROPIC_AUTH_TOKEN` for Vertex — the Google auth library mints short-lived access tokens from the service-account key on every request. As a result the profile's `auth:` block is typically omitted.

**Region-specific model availability.** `claude-sonnet-4-6` and `claude-opus-4-7` are not in every Vertex region. Check the current availability matrix in the Vertex Model Garden before pinning `CLOUD_ML_REGION` — `us-east5` and `europe-west1` are the broadest, but newer models often land in `us-east5` first.

**Model id includes a date suffix.** Vertex uses `claude-sonnet-4-5@20250929`, not the bare `claude-sonnet-4-5`. The `@<date>` pins a specific snapshot.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Could not load the default credentials` | `GOOGLE_APPLICATION_CREDENTIALS` unset or pointing at a missing file | Re-export the path; verify with `cat $GOOGLE_APPLICATION_CREDENTIALS \| jq .type` returning `"service_account"` |
| `Publisher Model ... not found` | Model not available in this region | Switch `CLOUD_ML_REGION`, or pick a model id present in your region |
| `PERMISSION_DENIED: aiplatform.endpoints.predict` | Service account missing the `Vertex AI User` role | Grant `roles/aiplatform.user` on the project to the service account |
| 429 quota errors | Per-project / per-region Vertex quota exhausted | Request a quota increase, or shift region |
