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
      "const { resolveSessionMetadataValue } = await import('./src/lib/session/selection.ts');",
      `const fanout = ${JSON.stringify(fanout)};`,
      'let forwarded;',
      'const deps = { gatherRemoteList: async (args) => { forwarded = args; return fanout; } };',
      `const outcome = await resolveSessionMetadataValue(${JSON.stringify(selector)}, {}, deps);`,
      'process.stdout.write(JSON.stringify({ outcome, forwarded }));',
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

  it('resolves a session on a reachable peer even while another device is offline, asking peers with ps resolve', () => {
    const { status, stdout, stderr } = runResolveSessionMetadata('71f4b54c', {
      sessions: [onReachablePeer],
      unreachable: ['mac-mini'],
    });
    expect(status, stderr).toBe(0);
    const { outcome, forwarded } = JSON.parse(stdout);
    expect(outcome).toMatchObject({ kind: 'resolved', session: { id, machine: 'yosemite-s1' } });
    expect(forwarded).toEqual(['ps', 'resolve', '71f4b54c', '--json', '--local']);
  });

  it('reports a genuinely-partial outcome naming the offline device instead of a not-found', () => {
    const { status, stdout, stderr } = runResolveSessionMetadata('deadbeef', {
      sessions: [],
      unreachable: ['mac-mini'],
    });
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).outcome).toEqual({ kind: 'partial', failedPeers: ['mac-mini'] });
  });
});
