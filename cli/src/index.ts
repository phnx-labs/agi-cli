#!/usr/bin/env -S node --no-warnings=ExperimentalWarning




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
  const { writeStdoutFlushed } = await import('./lib/stdout.js');
  await writeStdoutFlushed(JSON.stringify({ v: 1, rows: exportClaudeUsageCacheRows() }));
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

if (process.argv[2] === '__lead-host') {
  const { runLeadHost } = await import('./lib/lead/client.js');
  process.exit(await runLeadHost(process.argv[3] ?? ''));
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

await import('./bootstrap.js');
