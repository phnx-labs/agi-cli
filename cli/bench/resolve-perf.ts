#!/usr/bin/env tsx

import { performance } from 'perf_hooks';
import { listInstalledVersions, invalidateInstalledVersionsCache, getGlobalDefault } from '../src/lib/installations/versions.js';
import { resolveAgentTargets } from '../src/lib/agent-spec/index.js';
import { ALL_AGENT_IDS } from '../src/lib/agents.js';
import type { AgentId } from '../src/lib/types.js';

const agent: AgentId | undefined = ALL_AGENT_IDS.find((a) => listInstalledVersions(a).length > 0);
if (!agent) {
  console.log(JSON.stringify({ error: 'no agent has installed versions on this host' }, null, 2));
  process.exit(0);
}
const installed = listInstalledVersions(agent);
const exactVer = installed[installed.length - 1];
const pinned = getGlobalDefault(agent);

function time(fn: () => void, iters: number): { totalMs: number; perCallUs: number } {
  for (let i = 0; i < Math.min(50, iters); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const totalMs = performance.now() - t0;
  return { totalMs: +totalMs.toFixed(3), perCallUs: +((totalMs * 1000) / iters).toFixed(3) };
}

const results: Record<string, unknown> = {
  host: { agent, installedCount: installed.length, exactVer, pinned },
};

{
  const cold = time(() => {
    invalidateInstalledVersionsCache(agent);
    listInstalledVersions(agent);
  }, 2000);
  const warm = time(() => listInstalledVersions(agent), 200000);
  results.listInstalledVersions = {
    cold,
    warm,
    speedup: +(cold.perCallUs / warm.perCallUs).toFixed(1),
  };
}

{
  listInstalledVersions(agent);
  results.fastPaths = {
    exact: time(() => resolveAgentTargets(`${agent}@${exactVer}`), 100000),
    pinned: pinned ? time(() => resolveAgentTargets(`${agent}@pinned`), 100000) : 'no-default-set',
    bare: time(() => resolveAgentTargets(`${agent}`), 100000),
  };
}

{
  results.enumeratePaths = {
    latest: time(() => resolveAgentTargets(`${agent}@latest`), 100000),
    all: time(() => resolveAgentTargets(`${agent}@all`), 100000),
  };
}

results.hotPath1000x = time(() => resolveAgentTargets(`${agent}@${exactVer}`), 1000);

console.log(JSON.stringify(results, null, 2));
