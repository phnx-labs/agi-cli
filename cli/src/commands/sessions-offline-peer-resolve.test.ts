import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();

function runResolveSessionMetadata(
  selector: string,
  fanout: { sessions: unknown[]; unreachable: string[] },
): { status: number | null; stdout: string; stderr: string } {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-rush2492-'));
  try {
    const runner = [
      "const { resolveSessionMetadata } = await import('./src/commands/sessions.ts');",
      `const fanout = ${JSON.stringify(fanout)};`,
      'const deps = { gatherRemoteList: async () => fanout };',
      `await resolveSessionMetadata(${JSON.stringify(selector)}, {}, deps);`,
    ].join(' ');
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', runner], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

describe('RUSH-2492 offline-peer session resolution (real call site)', () => {
  const id = '71f4b54c-1111-2222-3333-444455556666';
  const onReachablePeer = {
    id,
    shortId: '71f4b54c',
    agent: 'claude',
    version: '2.1.45',
    mode: 'edit',
    machine: 'yosemite-s1',
    timestamp: '2026-08-10T09:29:43.616Z',
    filePath: '/sessions/claude.jsonl',
  };

  it('resolves a session on a reachable peer (prints it, exit 0) even while another device is offline', () => {
    const { status, stdout, stderr } = runResolveSessionMetadata('71f4b54c', {
      sessions: [onReachablePeer],
      unreachable: ['mac-mini'],
    });
    expect(status, stderr).toBe(0);
    const printed = JSON.parse(stdout);
    expect(printed).toHaveLength(1);
    expect(printed[0].id).toBe(id);
    expect(stderr).not.toContain('did not answer');
  });

  it('degrades a genuinely-partial outcome to a warning + not-found at exit 1, never the old exit-2 abort', () => {
    const { status, stdout, stderr } = runResolveSessionMetadata('deadbeef', {
      sessions: [],
      unreachable: ['mac-mini'],
    });
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Warning: 1 device(s) unreachable, not checked: mac-mini');
    expect(stderr).toContain('No session matching "deadbeef" on any reachable device (1 unreachable, not checked).');
    expect(stderr).not.toContain('Partial session resolution');
  });
});
