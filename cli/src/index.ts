#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

/**
 * CLI entry point for agents-cli.
 *
 * Slim shell (RUSH-2335): no static imports at all, so the argv fast paths
 * below can answer without evaluating the commander + self-update +
 * command-registry graph. The full CLI loads via `await import('./bootstrap.js')`
 * once none of the fast paths match.
 *
 * Fast paths (must stay above the bootstrap import — ESM does not hoist dynamic
 * `import()`, but any static import here would still evaluate first):
 *   - `__launch-lease`
 *   - `__shim`
 *   - `__gh`
 *   - `__claude-statusline`
 *   - `__usage-ingest` / `__usage-export`
 *   - `__harness-update-run`
 *   - `__daemon-run`
 *   - `sessions` (read queries only — PHNX-4012)
 *
 * The synchronous secrets-broker fast paths (`__secrets-get` / `__secrets-ping`
 * / `__secrets-lock`) and `__vault-age-helper` moved out of this CLI entirely
 * with the standalone `secrets` engine (PHNX-3989) — agents-cli now talks to
 * it only through the bounded process client (`lib/secrets-client.ts`), never
 * through a hidden subcommand of its own.
 */

// No static imports remain in this slim shell (the last one, the secrets-broker
// sync-commands leaf, moved out with the standalone engine — PHNX-3989). An
// empty `export {}` is what makes this a module rather than a script, which is
// required for the top-level `await` the argv fast paths below use.
export {};

// Force exit on Ctrl+C when no interactive prompt is handling it — UNLESS a
// guarded harness auto-update pass is mutating this process transactionally
// (PHNX-3940). A hard exit mid-swap can leave an installation whose directory
// and metadata disagree, so defer ONLY while that guard is held; the pass sees
// the same SIGINT cooperatively (lib/installations/update-cancellation.ts) and
// stops at its next safe boundary. The depth is read through the shared
// `Symbol.for` registry key so this slim entry shell needs no static import of
// that module (agent.test.ts pins the single allowed import). Every other SIGINT
// still force-exits 130, and no other listener is touched.
process.on('SIGINT', () => {
  const depth = (globalThis as Record<symbol, number | undefined>)[Symbol.for('agents.guardedAutoUpdateDepth')] ?? 0;
  if (depth > 0) return;
  process.exit(130);
});

// Ignore SIGPIPE — prevents exit code 13 crashes in piped environments
// (e.g. `agents sessions | head`, or when stdout is captured by another process).
process.on('SIGPIPE', () => {});

// Launch-lease delegate: every generated native shim/alias calls
// `agents __launch-lease <agent> <label> <pid>` right before its final `exec`
// (PHNX-3940) — on the hot launch path of every managed agent, so it must skip
// the same update-check/bootstrap machinery `__shim` skips below. See
// `lib/installations/launch-gate.ts` for what this call actually does.
if (process.argv[2] === '__launch-lease') {
  const { runLaunchLeaseCli } = await import('./lib/installations/launch-gate.js');
  process.exit(await runLaunchLeaseCli(process.argv.slice(3)));
}

// Transparent shim delegate: the generated Windows `.cmd` shims invoke
// `agents __shim <agent>[@version] <raw args>`. Intercept here, before bootstrap
// parses anything, so the agent's own flags (`--help`, `--version`, etc.) pass
// through completely untouched and we skip registering the full command tree.
if (process.argv[2] === '__shim') {
  const spec = process.argv[3] || '';
  const rawArgs = process.argv.slice(4);
  const atIndex = spec.indexOf('@');
  const agent = atIndex === -1 ? spec : spec.slice(0, atIndex);
  const pinned = atIndex === -1 ? undefined : spec.slice(atIndex + 1);
  const { execShimPassthrough } = await import('./lib/exec.js');
  const code = await execShimPassthrough(agent as import('./lib/types.js').AgentId, rawArgs, process.cwd(), pinned || undefined);
  process.exit(code);
}

// gh overload delegate: the `gh` PATH shim routes `gh pr checks` here as
// `agents __gh --real-gh <path> -- pr checks …`, so the rate-limit-prone read
// runs over REST instead of GraphQL (PHNX-3501). Above bootstrap for the same
// reason as __shim: no update check, no command-tree load — this is on the hot
// path of an agent's CI watch, and the gh argv must pass through untouched.
if (process.argv[2] === '__gh') {
  const { runGhOverload } = await import('./lib/github/gh-overload.js');
  process.exit(await runGhOverload(process.argv.slice(3)));
}

if (process.argv[2] === '__claude-statusline') {
  const { runClaudeStatusLine } = await import('./lib/claude-statusline.js');
  process.exit(await runClaudeStatusLine());
}

// Fleet usage-sync receiver: a headed peer pipes its identity-keyed usage rows to
// stdin, we merge them newest-wins into this box's cache (PHNX-3392). Above the
// bootstrap line for the same reason as __claude-statusline — no update check, no
// detached sync fork, and nothing writes to stdout to corrupt the caller's view.
if (process.argv[2] === '__usage-ingest') {
  const { runUsageIngest } = await import('./lib/accounting/usage-ingest.js');
  process.exit(await runUsageIngest());
}

if (process.argv[2] === '__usage-export') {
  const { exportClaudeUsageCacheRows } = await import('./lib/accounting/usage.js');
  process.stdout.write(JSON.stringify({ v: 1, rows: exportClaudeUsageCacheRows() }));
  process.exit(0);
}

// Harness auto-update child (PHNX-3940): the daemon's harness-update tick spawns
// `agents __harness-update-run` over a Node IPC channel and cancels it
// cooperatively by MESSAGE, never a kill (see
// lib/daemon/harness-update-service.ts + lib/installations/update-cancellation.ts).
// Above bootstrap for the same reason as __daemon-run: this internal periodic
// child must not itself fire a self-update check or fork a detached sync, and its
// stdout carries a clean JSON summary the daemon logs.
if (process.argv[2] === '__harness-update-run') {
  const { runHarnessUpdateChild } = await import('./lib/installations/update-runtime.js');
  process.exit(await runHarnessUpdateChild());
}

if (process.argv[2] === '__daemon-run') {
  const { runDaemon, log: daemonLog } = await import('./lib/daemon/daemon.js');

  // RUSH-2418: the daemon is the one always-on process here, and it ran with no
  // top-level handler of any kind — an uncaught throw or a rejected promise from
  // any of its background ticks died on Node's default handler, printing a raw
  // stack to whatever the service manager had wired to stdout and never reaching
  // the daemon's own structured log. Route both into log() so the failure is in
  // logs.jsonl where `agents daemon logs` reads it, then exit non-zero and
  // DELIBERATELY let the supervisor restart us — now paced by the plist's
  // ThrottleInterval / the unit's StartLimitBurst. Swallowing here would be the
  // worse failure: a daemon left alive with a dead subsystem.
  const crash = (kind: string) => (err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try { daemonLog('ERROR', `${kind}: ${detail}`); } catch { /* log path unwritable — stderr below still carries it */ }
    process.stderr.write(`[agents] daemon ${kind}: ${detail}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', crash('uncaughtException'));
  process.on('unhandledRejection', crash('unhandledRejection'));

  try {
    await runDaemon();
  } catch (err) {
    crash('startup failure')(err);
  }
  process.exit(process.exitCode ?? 0);
}

// PHNX-4012: search/list/id lookup of `agents sessions` execs the standalone
// `sessions` binary without loading bootstrap or the 6K-line sessions module.
// Lifecycle verbs (resume/stop/inject/watch/--active/--markdown) fall through.
if (process.argv[2] === 'sessions') {
  const forwarded = process.argv.slice(3);
  const {
    isReadQuery,
    resolveSessionsBin,
    invocation,
    SessionsClientError,
    SESSIONS_INSTALL_HINT,
  } = await import('./lib/sessions-client.js');
  if (isReadQuery(forwarded)) {
    const { spawnSync } = await import('node:child_process');
    let bin: string;
    try {
      bin = resolveSessionsBin();
    } catch (err) {
      if (err instanceof SessionsClientError && err.code === 'SESSIONS_BIN_MISSING') {
        process.stderr.write('The standalone `sessions` CLI is not installed.\n');
        process.stderr.write(`Install it, then re-run this command:\n  ${SESSIONS_INSTALL_HINT}\n`);
        process.exit(1);
      }
      throw err;
    }
    const { command, prefix } = invocation(bin);
    const res = spawnSync(command, [...prefix, ...forwarded], { stdio: 'inherit' });
    if (res.error) {
      process.stderr.write(`Failed to run \`sessions\`: ${res.error.message}\n`);
      process.exit(1);
    }
    process.exit(res.status ?? 1);
  }
}

// Full CLI: commander tree, update checks, migrations, parse. Static imports
// inside bootstrap.js evaluate only when we reach this line.
await import('./bootstrap.js');
