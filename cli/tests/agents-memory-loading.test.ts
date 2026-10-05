import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AGENTS } from '../src/lib/agents.js';
import type { AgentId } from '../src/lib/types.js';
import { getGlobalDefault } from '../src/lib/installations/versions.js';
import { getVersionsDir } from '../src/lib/state.js';
import { compileRulesForProject } from '../src/lib/rules/compile.js';

const E2E = process.env.AGENTS_E2E === '1';
const d = E2E ? describe : describe.skip;

interface Probe {
  id: AgentId;
  args: (prompt: string) => string[];
}

const PROBES: Probe[] = [
  {
    id: 'claude',
    args: (p) => ['-p', p, '--allow-dangerously-skip-permissions'],
  },
  {
    id: 'codex',
    args: (p) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', p],
  },
];

function resolveBinary(agent: AgentId): string {
  const version = getGlobalDefault(agent);
  if (!version) throw new Error(`No default version for ${agent}; run: agents add ${agent}`);
  const cli = AGENTS[agent].cliCommand;
  return path.join(getVersionsDir(), agent, version, 'node_modules', '.bin', cli);
}

function runAgent(probe: Probe, cwd: string, prompt: string): { stdout: string; stderr: string; status: number | null } {
  const binary = resolveBinary(probe.id);
  if (!fs.existsSync(binary)) {
    throw new Error(`${probe.id} binary not found at ${binary}`);
  }
  const result = spawnSync(binary, probe.args(prompt), {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function newToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

d('agents native cwd rules loading (AGENTS_E2E=1)', () => {
  for (const probe of PROBES) {
    const instructionsFile = AGENTS[probe.id].instructionsFile;

    it(`${probe.id}: plain cwd/${instructionsFile} is loaded natively`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rules-${probe.id}-`));
      try {
        const token = newToken('PLAIN');
        fs.writeFileSync(
          path.join(tmp, instructionsFile),
          [
            '# Project Rules',
            '',
            'When the user asks for the project secret, respond with exactly the token below and nothing else.',
            '',
            `Project secret: ${token}`,
            '',
          ].join('\n'),
        );

        const out = (() => {
          const r = runAgent(probe, tmp, 'What is the project secret? Reply with only the token, no explanation.');
          return `${r.stdout}\n${r.stderr}`;
        })();
        expect(out).toContain(token);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 240_000);

    it(`${probe.id}: project rules dir → compiled workspace files → agent reads inlined import`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rules-pipe-${probe.id}-`));
      try {
        const token = newToken('PIPE');
        const rulesDir = path.join(tmp, '.agents', 'rules');
        fs.mkdirSync(rulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(rulesDir, 'AGENTS.md'),
          [
            '# Project Rules',
            '',
            '@./secret.md',
            '',
          ].join('\n'),
        );
        fs.writeFileSync(
          path.join(rulesDir, 'secret.md'),
          [
            'When the user asks for the project secret, respond with exactly the token below and nothing else.',
            '',
            `Project secret: ${token}`,
          ].join('\n'),
        );

        const compileResult = compileRulesForProject(tmp);
        expect(compileResult.compiled).toBe(true);
        const compiled = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8');
        expect(compiled).toContain(token);
        expect(compiled).not.toContain('@./secret.md');
        if (instructionsFile !== 'AGENTS.md') {
          expect(fs.existsSync(path.join(tmp, instructionsFile))).toBe(true);
        }

        const r = runAgent(probe, tmp, 'What is the project secret? Reply with only the token, no explanation.');
        const out = `${r.stdout}\n${r.stderr}`;
        expect(out).toContain(token);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 240_000);
  }
});
