#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// Keep this entry shell free of static imports: internal delegates and eligible session reads must stay above bootstrap to skip update and registration.
// SIGINT defers only during guarded install swaps; daemon crashes log and exit for supervisor restart; missing/old remote sessions fall back to the canonical engine.


export {};

process.on('SIGINT', () => {
  const depth = (globalThis as Record<symbol, number | undefined>)[Symbol.for('agents.guardedAutoUpdateDepth')] ?? 0;
  if (depth > 0) return;
  process.exit(130);
});

process.on('SIGPIPE', () => {});

if (process.argv[2] === '__launch-lease') {
  const { runLaunchLeaseCli } = await import('./lib/installations/launch-gate.js');
  process.exit(await runLaunchLeaseCli(process.argv.slice(3)));
}

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

if (process.argv[2] === '__gh') {
  const { runGhOverload } = await import('./lib/github/gh-overload.js');
  process.exit(await runGhOverload(process.argv.slice(3)));
}

if (process.argv[2] === '__claude-statusline') {
  const { runClaudeStatusLine } = await import('./lib/claude-statusline.js');
  process.exit(await runClaudeStatusLine());
}

if (process.argv[2] === '__usage-ingest') {
  const { runUsageIngest } = await import('./lib/accounting/usage-ingest.js');
  process.exit(await runUsageIngest());
}

if (process.argv[2] === '__usage-export') {
  const { exportClaudeUsageCacheRows } = await import('./lib/accounting/usage.js');
  process.stdout.write(JSON.stringify({ v: 1, rows: exportClaudeUsageCacheRows() }));
  process.exit(0);
}

if (process.argv[2] === '__harness-update-run') {
  const { runHarnessUpdateChild } = await import('./lib/installations/update-runtime.js');
  process.exit(await runHarnessUpdateChild());
}

if (process.argv[2] === '__self-heal-run') {
  const { runSelfHealChild } = await import('./lib/self-heal/child.js');
  process.exit(await runSelfHealChild());
}

if (process.argv[2] === '__daemon-run') {
  const { runDaemon, log: daemonLog } = await import('./lib/daemon/daemon.js');

  const crash = (kind: string) => (err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try { daemonLog('ERROR', `${kind}: ${detail}`); } catch {  }
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

if (process.argv[2] === 'sessions') {
  const forwarded = process.argv.slice(3);
  const {
    isReadQuery,
    usesFilterFlags,
    usesHostFlag,
    sessionsBinSupportsFilters,
    sessionsBinSupportsHost,
    planDeviceHostRead,
    resolveSessionsBin,
    invocation,
    SessionsClientError,
    SESSIONS_INSTALL_HINT,
  } = await import('./lib/sessions-client.js');
  let bin: string | null = null;
  try {
    bin = resolveSessionsBin();
  } catch (err) {
    if (!(err instanceof SessionsClientError && err.code === 'SESSIONS_BIN_MISSING')) throw err;
  }
  const filters = bin !== null && usesFilterFlags(forwarded) ? sessionsBinSupportsFilters(bin) : false;
  const host = bin !== null && usesHostFlag(forwarded) ? sessionsBinSupportsHost(bin) : false;

  if (bin !== null) {
    const deviceRead = planDeviceHostRead(forwarded, { filters });
    if (deviceRead && sessionsBinSupportsHost(bin)) {
      let target: string | null = null;
      try {
        const { resolveRemoteDevice } = await import('./lib/ssh-tunnel.js');
        target = (await resolveRemoteDevice(deviceRead.device, {})).target;
      } catch {
        target = null;
      }
      if (target !== null) {
        const { spawnSync } = await import('node:child_process');
        const { command, prefix } = invocation(bin);
        const hostArgs = [...deviceRead.readArgs, '--host', `ssh://${target}`];
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        if (process.stdout.isTTY && !hostArgs.includes('--json')) {
          if (childEnv.FORCE_COLOR === undefined) childEnv.FORCE_COLOR = '1';
          if (process.stdout.columns) childEnv.COLUMNS = String(process.stdout.columns);
          if (process.stdout.rows) childEnv.LINES = String(process.stdout.rows);
        }
        const res = spawnSync(command, [...prefix, ...hostArgs], {
          encoding: 'utf8',
          env: childEnv,
          maxBuffer: 256 * 1024 * 1024,
        });
        if (res.error) {
          process.stderr.write(`Failed to run \`sessions\`: ${res.error.message}\n`);
          process.exit(1);
        }
        if (res.status !== 127) {
          if (res.stdout) process.stdout.write(res.stdout);
          if (res.stderr) process.stderr.write(res.stderr);
          process.exit(res.status ?? 1);
        }
      }
    }
  }

  if (isReadQuery(forwarded, { filters, host })) {
    if (bin) {
      const { spawnSync } = await import('node:child_process');
      const { command, prefix } = invocation(bin);
      const res = spawnSync(command, [...prefix, ...forwarded], { stdio: 'inherit' });
      if (res.error) {
        process.stderr.write(`Failed to run \`sessions\`: ${res.error.message}\n`);
        process.exit(1);
      }
      process.exit(res.status ?? 1);
    }
    if (process.env.AGENTS_SESSIONS_FASTPATH_HINT !== '0') {
      process.stderr.write(`agents: standalone \`sessions\` not installed; using the in-process engine (${SESSIONS_INSTALL_HINT})\n`);
    }
  }
}

await import('./bootstrap.js');
