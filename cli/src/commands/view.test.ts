import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const viewUrl = new URL('./view.ts', import.meta.url).href;
const storeUrl = new URL('../lib/installations/store.ts', import.meta.url).href;
const agentsUrl = new URL('../lib/agent-spec/agents.ts', import.meta.url).href;

describe('view installed releases', () => {
  it.each([
    ['codex', '0.144.1', '0.163.0', 'Codex'],
    ['claude', 'main', '2.1.299', 'Claude'],
    ['opencode', '1.0.0', '2.0.28', 'OpenCode'],
    ['codex', '0.163.0', '0.163.0', 'Codex'],
  ])('%s details show release %s -> %s without changing the installation', (agent, label, release, name) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-view-release-'));
    try {
      const output = execFileSync('bun', ['-e', String.raw`
        process.env.PATH = process.env.HOME;
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { createInstallation, getVersionHomePath, readInstallation } = await import(${JSON.stringify(storeUrl)});
        const { agentConfigDirName } = await import(${JSON.stringify(agentsUrl)});
        const { viewAction } = await import(${JSON.stringify(viewUrl)});
        const agent = ${JSON.stringify(agent)};
        const label = ${JSON.stringify(label)};
        const release = ${JSON.stringify(release)};
        const installation = createInstallation(agent, label, release);
        fs.writeFileSync(path.join(process.env.HOME, '.agents', 'agents.yaml'),
          'agents:\n  ' + agent + ': "' + label + '"\n');
        const skillDir = path.join(getVersionHomePath(agent, label), agentConfigDirName(agent), 'skills', 'release-check');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
          '---\nname: release-check\ndescription: Check installed releases\n---\n# Release check\n');
        await viewAction(agent + '@default');
        await viewAction(agent, { skills: true });
        if (JSON.stringify(readInstallation(agent, label)) !== JSON.stringify(installation)) {
          throw new Error('Viewing resources changed the installation record');
        }
      `], {
        cwd: home,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AGENTS_REAL_HOME: home,
          FORCE_COLOR: '0',
        },
      });
      const summary = output.split('\n').find(line => line.trimStart().startsWith(name + ' '));
      expect(summary).toContain(release);
      if (label !== release) {
        expect(summary).toContain(`${release} (installation: ${label})`);
      } else {
        expect(output).not.toContain('(installation:');
      }
      const headers = output.split('\n').filter(line => line.trimStart().startsWith(name + ' ('));
      expect(headers.length).toBeGreaterThanOrEqual(2);
      expect(headers.every(line => line.trim() === `${name} (${release}):`)).toBe(true);
      expect(output).toContain('release-check');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
