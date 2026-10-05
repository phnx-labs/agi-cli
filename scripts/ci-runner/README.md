# ci-runner — shared no-lease untrusted executor

> **NOT the current CI direction (2026-09-01).** The owner has declined to
> operate a self-managed executor, and measurement shows it would not address the
> bottleneck: a required check spends ~19s on a cold `bun install` and ~0.27s
> executing tests. CI stays on GitHub-hosted runners; the fix is a
> lockfile-keyed dependency cache. This tree is retained as working machinery,
> not as the path to the latency bar — see
> `.agents/artifacts/2026-09-01/plan-ci-github-hosted.md`.

Standing compute for RUSH-2666. One always-on Crabbox is a **shared
multi-repository executor**, not a leased box and not a persistent GitHub
Actions runner that executes pull-request code.

Required-check budget: event-to-terminal **P99 / P99.9 / P99.99 ≤ 90s**
(warm cache-hit stretch ≤ 10s). Ordinary release **P99 ≤ 180s**. Windows
is not a required pull-request or release gate.

## What this host is

The host is only a controller, cache substrate, and Firecracker launcher.

```
/srv/ci/mirrors/<owner>/<repo>.git
/srv/ci/runs/<owner>/<repo>/<candidate-tree>/<check-run-id>/worktree
/srv/ci/results/<owner>/<repo>/<check-run-id>/
/srv/ci/cache/bun/<lockfile-digest>/
```

A submit contains repository identity, candidate commit/tree, impact-plan
digest, resource class, and check-run id. It **never** contains a box
lease or a caller-chosen checkout. The broker derives the worktree and
returns the run id (`checkRunId`).

Each admitted job:

1. Creates a detached worktree named by candidate tree + check-run id.
2. Restores a **warm one-use Firecracker** snapshot and execs `firecracker`
   (`FIRECRACKER_BIN` or PATH). Missing binary is a hard error — the job
   never runs on the controller host.
3. Mounts only that worktree (rw) and the content-addressed Bun cache (ro).
4. Runs with no signing, npm, GitHub-write, fleet, SSH, or user secrets.
5. Exposes raw logs only. The controller hashes reports and signs the
   attestation with a key that is never mounted into the worker.
6. Destroys the microVM and removes the worktree.

Repos and agents run concurrently up to CPU/memory slots. When slots are
full the job enters a **fair per-repository queue** — short-lived
admission, not an exclusive machine lease. A per-repo cap stops one
repository starving the rest.

## Trust split

| Lane | Where it runs | Cache |
| --- | --- | --- |
| Same-repository PR (after isolation gate) | this executor | read-write populate of content-addressed digests |
| Fork PR | GitHub-hosted only | restore-only; never writes trusted cache |
| `main` / schedule / release | existing trusted `crabbox-ci` runners | unchanged |

Fork code is never scheduled here. The `crabbox-ci` label stays forbidden
on every `pull_request` trigger.

## Operating it

```sh
# unit + executor tests (real git worktrees + local one-use jail)
bun test scripts/ci-runner

# warm-path benchmark (P99 / P99.9 / P99.99 of admit→attest)
bun scripts/ci-runner/cli.ts bench 32

# submit a request (CI_ROOT overrides /srv/ci)
CI_ROOT=/tmp/ci bun scripts/ci-runner/cli.ts submit request.json
```

Supervisor and janitor still cover the **trusted** org-runner pool on
`ci-runner-fsn1` (see `supervise.sh`, `janitor.sh`,
`provision-phnx-runners.sh`). The untrusted executor is a separate
standing Crabbox: no tailnet, no durable credentials, no host sockets.

## Files

| File | Purpose |
| --- | --- |
| `src/broker.ts` | no-lease admit / queue / run id |
| `src/fairness.ts` | slot weights + per-repo cap + fair next |
| `src/firecracker.ts` | warm snapshot, one-use VM, mount policy |
| `src/cache.ts` | content-addressed Bun cache, restore-only forks |
| `src/worktree.ts` | namespaced detached worktrees from a mirror |
| `src/execute.ts` | controller-observed run + signed attestation |
| `src/timing.ts` | queue/setup/exec/report + percentile budgets |
| `src/benchmark.ts` | warm-path P99 / P99.9 / P99.99 |
| `cli.ts` | `submit` and `bench` |
| `janitor.sh` | trusted-pool hygiene; honors `CI_ROOT` for executor sweep |
