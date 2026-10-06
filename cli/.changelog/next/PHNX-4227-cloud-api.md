- **`agents cloud transcripts` and `agents sessions --cloud` work against the current Rush API (PHNX-4227).**
  Both failed with `cloud-runs list failed (404)` because Rush retired `/api/v1/cloud-runs`.
  They now list your organization's sessions across every project (`GET /o/{org}/sessions`) and
  fetch a transcript as raw NDJSON from `/o/{org}/p/_/sessions/{id}/trajectory`. The organization
  is the one saved in `~/.rush/user.yaml`, else your personal one, as `rush` resolves it. Each run
  is parsed by its captured harness rather than its agent profile name.
  Source: `cli/src/lib/session/cloud.ts`, `cli/src/lib/cloud/rush.ts`.
