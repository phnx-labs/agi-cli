# Benchmarks

Measured numbers for CLI hot paths. **This file is the ledger.** Do not dump
tables onto Linear tickets — check a new row in here (and keep the reproducing
`.bench.ts` next to the code).

This file is *what we measured*, including negative results. Design notes for
what we changed live next to the code and in [distribution.md](distribution.md)
/ [execution.md](execution.md) where they are architectural.

Re-run locally from `cli/`:

```bash
npx vitest bench --run src/lib/index.bench.ts
npx vitest bench --run src/lib/events.bench.ts
npx vitest bench --run src/lib/brand.bench.ts
npx vitest bench --run src/lib/hosts/passthrough.bench.ts
```

Every row below is a real bench mean unless marked otherwise. Cite machine, node,
and the commit or PR that produced the run.

---

## Commander bootstrap and audit hooks (2026-08-07)

**Source ticket (data only, not the home):** [RUSH-2385](https://linear.app/getrush/issue/RUSH-2385).
**Bench:** `src/lib/index.bench.ts` (landed [PR #2349](https://github.com/phnx-labs/agi-cli/pull/2349)).
**Machine:** yosemite-s1, linux, node v24.11.1, vitest 4.1.9. Two full `npx vitest bench --run` passes.

| Row | Run 1 mean | Run 2 mean |
| --- | --- | --- |
| FLOOR: bare `node --input-type=module -e ""` | 20.38 ms | 18.94 ms |
| `import commander` (`index.ts` commander import) | 31.74 ms | 32.40 ms |
| FLOOR with warm `NODE_COMPILE_CACHE` | n/a | 19.47 ms |
| `import commander` with warm `NODE_COMPILE_CACHE` | n/a | 30.36 ms |
| `new Command()` | 0.0002 ms | 0.0002 ms |
| root option chain | 0.0015 ms | 0.0014 ms |
| both `program.hook(...)` registrations | 0.0003 ms | 0.0003 ms |
| COMPLETE root bootstrap (construct + options + hooks) | 0.0015 ms | 0.0015 ms |
| `parseAsync` `agents noop`, no hooks | 0.0013 ms | 0.0014 ms |
| `parseAsync` `agents noop`, WITH audit hooks | 0.2027 ms | 0.1947 ms |
| `parseAsync` `agents events emit` (AUDIT_EXEMPT), WITH hooks | 0.0020 ms | 0.0020 ms |
| COUNTERFACTUAL: WITH hooks, one append instead of two | n/a | 0.0968 ms |
| anchor: cold `node dist/index.js --version` | 212.52 ms | 220.78 ms |

**Read of the numbers (same run):**

- Audit hooks cost **~195 µs/command** (hooked 0.195–0.203 ms vs unhooked 0.0013–0.0014 ms). ~99.7% of that is inside `emit()`, not commander hook wiring (~0.6 µs, 0.3% of the tax).
- One-append instead of `command.start` + `command.end` halves it (~97 µs). Tradeoff: a killed command then leaves no audit line.
- Complete root bootstrap (0.0015 ms) is **0.0007%** of a 212–221 ms cold `--version`. Do not micro-optimize `new Command()` / option chain / hook registration.
- `import { Command } from 'commander'` is **11.4–13.5 ms** cold (~5–6% of `--version`). Cannot be lazy with the current entry graph.
- `NODE_COMPILE_CACHE` **did not reproduce** as a win: warm-vs-cold sign flipped across runs (10.89 vs 13.46, then 12.05 vs 12.53, then 12.50 vs 10.98). Keep the rows as a negative result.

Zion wall-clock check (load 27.94 / 17.73 / 12.85): installed `agents --version` 0.10s, 0.09s, 0.09s (median 0.09s).

Raw log: https://share.agents-cli.sh/muqsitnawaz/perf-bench-commander-root-bootstrap-20260807t1101-index-bench-run3-3184dd5828c01b24

---

## Sync on every launch (fingerprint / manifest skip)

Historical profile (pre-manifest, yosemite-class):

Before the sync manifest, a typical launch paid **~16s wall** on yosemite-class hardware, ~10s of that filesystem mutation (`copyFile` 5.87s / 37%, `unlink` 1.11s, `readdir` 1.11s, YAML 1.07s, chmod 0.97s, …). Unconditional delete-and-recopy of 26 commands + 29 skills + hooks + rules.

That cost is the reason the fingerprint/manifest skip exists. Re-measure against this table if launch sync regresses.

---

## SSH transport

A/B harness: `cli/scripts/bench-ssh.mjs` (needs a live host). Also `cli/bench/`
(`sessions-perf.ts`, `view-usage-perf.ts`, `sessions-active-perf.ts`). Record
new SSH P50/P99 here when you re-run; do not paste them only on a ticket.

---

## Other committed benches (no table in git yet)

These files exist so the next run has a place to land a table in *this* document:

| File | What it times |
| --- | --- |
| `src/lib/index.bench.ts` | Entry hot path / commander / audit (table above) |
| `src/lib/events.bench.ts` | `emit()` internals (the ~195 µs tax) |
| `src/lib/brand.bench.ts` | Brand/module import cost |
| `src/lib/hosts/passthrough.bench.ts` | `--device` passthrough path |

When you add a row, include machine, node version, vitest version, and a commit SHA.

---

## Open levers (not measurements)

Tracked as work, not as a dump of numbers:

1. Fold `command.start` into `command.end` (~98 µs/command) if losing crash-start audit lines is acceptable.
2. Decompose `emit()` (`src/lib/feed/events.ts`) — that is where 99.7% of the hook tax lives. `events.bench.ts` is the harness.
3. Do not restructure `index.ts` construct/option/hook registration — measured 0.0007% of cold `--version`.
4. Commander module load (11–13 ms) is the one real startup slice in this family; lazy import is blocked by the current graph.
