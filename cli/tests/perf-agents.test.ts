import { describe, it, expect } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isCliInstalled,
  getCliVersion,
  getCliPath,
  getCliState,
  getAllCliStates,
  getAccountEmail,
  AGENTS,
  ALL_AGENT_IDS,
} from '../src/lib/agents.js';
import { listInstalledVersions, getVersionHomePath } from '../src/lib/installations/versions.js';

const execAsync = promisify(exec);

function timeMs(start: [number, number]): number {
  const [s, ns] = process.hrtime(start);
  return s * 1000 + ns / 1e6;
}

const describePerf = process.env.PERF === '1' ? describe : describe.skip;

describePerf('agents perf (manual; run with PERF=1)', () => {
  it('single which call', async () => {
    const start = process.hrtime();
    await execAsync('which claude');
    const ms = timeMs(start);
    console.log(`  which claude: ${ms.toFixed(1)}ms`);
  });

  it('single --version call', async () => {
    const start = process.hrtime();
    await execAsync('claude --version');
    const ms = timeMs(start);
    console.log(`  claude --version: ${ms.toFixed(1)}ms`);
  });

  it('isCliInstalled per agent', async () => {
    for (const agentId of ALL_AGENT_IDS) {
      const start = process.hrtime();
      await isCliInstalled(agentId);
      const ms = timeMs(start);
      console.log(`  isCliInstalled(${agentId}): ${ms.toFixed(1)}ms`);
    }
  });

  it('getCliVersion per agent', async () => {
    for (const agentId of ALL_AGENT_IDS) {
      const start = process.hrtime();
      try {
        await getCliVersion(agentId);
      } catch {}
      const ms = timeMs(start);
      console.log(`  getCliVersion(${agentId}): ${ms.toFixed(1)}ms`);
    }
  });

  it('getCliState per agent (sequential)', async () => {
    let total = 0;
    const versions = await import('../src/lib/installations/versions.js');
    for (const agentId of ALL_AGENT_IDS) {
      const managed = versions.listInstalledVersions(agentId).length > 0;
      const start = process.hrtime();
      await getCliState(agentId);
      const ms = timeMs(start);
      total += ms;
      const tag = managed ? 'fast-path' : 'slow-path';
      console.log(`  getCliState(${agentId}): ${ms.toFixed(1)}ms [${tag}]`);
    }
    console.log(`  total sequential: ${total.toFixed(1)}ms`);
  });

  it('getAllCliStates (parallel)', async () => {
    const start = process.hrtime();
    await getAllCliStates();
    const ms = timeMs(start);
    console.log(`  getAllCliStates: ${ms.toFixed(1)}ms`);
  });

  it('getAccountEmail per version (file reads)', async () => {
    for (const agentId of ALL_AGENT_IDS) {
      const versions = listInstalledVersions(agentId);
      if (versions.length === 0) {
        const start = process.hrtime();
        await getAccountEmail(agentId);
        const ms = timeMs(start);
        console.log(`  getAccountEmail(${agentId}, global): ${ms.toFixed(1)}ms`);
        continue;
      }
      for (const ver of versions) {
        const home = getVersionHomePath(agentId, ver);
        const start = process.hrtime();
        await getAccountEmail(agentId, home);
        const ms = timeMs(start);
        console.log(`  getAccountEmail(${agentId}@${ver}): ${ms.toFixed(1)}ms`);
      }
    }
  });

  it('full agents list simulation', async () => {
    console.log('\n  --- Full agents list breakdown ---');

    const t0 = process.hrtime();
    const cliStates = await getAllCliStates();
    const cliMs = timeMs(t0);
    console.log(`  1. getAllCliStates: ${cliMs.toFixed(1)}ms`);

    const t1 = process.hrtime();
    const emailFetches: Promise<{ agentId: string; version: string; email: string | null }>[] = [];
    const globalEmailFetches: Promise<{ agentId: string; email: string | null }>[] = [];
    for (const agentId of ALL_AGENT_IDS) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0) {
        for (const ver of versions) {
          emailFetches.push(
            getAccountEmail(agentId, getVersionHomePath(agentId, ver)).then((email) => ({
              agentId,
              version: ver,
              email,
            }))
          );
        }
      } else {
        globalEmailFetches.push(
          getAccountEmail(agentId).then((email) => ({ agentId, email }))
        );
      }
    }
    await Promise.all(emailFetches);
    await Promise.all(globalEmailFetches);
    const emailMs = timeMs(t1);
    console.log(`  2. all email fetches: ${emailMs.toFixed(1)}ms`);

    console.log(`  TOTAL: ${(cliMs + emailMs).toFixed(1)}ms`);
    console.log(`  ratio: getAllCliStates=${((cliMs / (cliMs + emailMs)) * 100).toFixed(0)}% emails=${((emailMs / (cliMs + emailMs)) * 100).toFixed(0)}%`);
  });
});
