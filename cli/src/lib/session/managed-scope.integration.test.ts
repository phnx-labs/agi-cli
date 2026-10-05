import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('agents sessions — managed-only scope', () => {
  let home: string;

  const managedSessions = (v: string) =>
    path.join(home, '.agents', '.history', 'versions', 'codex', v, 'home', '.codex', 'sessions', '2026', '07', '30');
  const unmanagedSessions = () => path.join(home, '.codex', 'sessions', '2026', '07', '30');

  function writeRollout(dir: string, id: string, cwd: string) {
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
      timestamp: '2026-07-30T18:20:00.970Z',
      type: 'session_meta',
      payload: {
        session_id: id, id, timestamp: '2026-07-30T18:20:00.870Z',
        cwd, originator: 'codex_exec', cli_version: '0.146.0', source: 'exec',
      },
    };
    const msg = {
      timestamp: '2026-07-30T18:20:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    };
    fs.writeFileSync(
      path.join(dir, `rollout-2026-07-30T18-20-00-${id}.jsonl`),
      `${JSON.stringify(meta)}\n${JSON.stringify(msg)}\n`,
    );
  }

  function plantManagedVersion(v: string) {
    const binDir = path.join(home, '.agents', '.history', 'versions', 'codex', v, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'codex'), 0o755);
    fs.writeFileSync(path.join(home, '.agents', '.history', 'versions', 'codex', v, 'package.json'), '{}');
  }

  function run(...args: string[]): string {
    try {
      return execFileSync('node', ['--import', 'tsx', path.resolve(process.cwd(), 'src/index.ts'), 'sessions', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home, SHELL: '/bin/bash', AGENTS_NO_NUDGE: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
  }

  const ids = (out: string): string[] => {
    try {
      const d = JSON.parse(out);
      const rows = Array.isArray(d) ? d : (d.sessions ?? []);
      return rows.map((r: { id: string }) => r.id).sort();
    } catch { return []; }
  };

  const MANAGED = '019fb5c1-bd63-7572-8a96-944978cb3000';
  const UNMANAGED = '019fa4ee-cde3-7eb3-b0fb-fdd912889d9b';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-scope-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
    writeRollout(unmanagedSessions(), UNMANAGED, home);
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('lists everything when agents-cli manages nothing — unchanged for a new user', () => {
    const out = ids(run('--all', '-n', '50', '--json'));
    expect(out).toContain(UNMANAGED);
  }, 180_000);

  it('hides unmanaged sessions once a version is managed, and keeps the managed one', () => {
    plantManagedVersion('0.146.0');
    writeRollout(managedSessions('0.146.0'), MANAGED, home);

    const out = ids(run('--all', '-n', '50', '--json'));
    expect(out).toContain(MANAGED);
    expect(out).not.toContain(UNMANAGED);
  }, 180_000);

  it('--unmanaged brings them back without a re-scan', () => {
    plantManagedVersion('0.146.0');
    writeRollout(managedSessions('0.146.0'), MANAGED, home);

    const out = ids(run('--all', '-n', '50', '--unmanaged', '--json'));
    expect(out).toContain(MANAGED);
    expect(out).toContain(UNMANAGED);
  }, 180_000);

  it('says what it hid — in every render path, not just one', () => {
    plantManagedVersion('0.146.0');
    writeRollout(managedSessions('0.146.0'), MANAGED, home);

    for (const mode of [['--flat'], ['--tree'], []]) {
      const out = run('--all', '-n', '10', ...mode);
      expect(out, `mode: ${mode[0] ?? 'overview'}`).toContain('unmanaged installs hidden');
    }
  }, 180_000);

  it("counts codex's RELOCATED short home as managed, not as the user's own", () => {
    plantManagedVersion('0.146.0');
    fs.writeFileSync(path.join(home, '.agents', '.history', 'versions', 'codex', '0.146.0', '.isolated'), 'x\n');
    const relocated = path.join(home, '.agents', '.codex-homes', '0.146.0', '.codex', 'sessions', '2026', '07', '30');
    writeRollout(relocated, MANAGED, home);

    const out = ids(run('--all', '-n', '50', '--json'));
    expect(out).toContain(MANAGED);
    expect(out).not.toContain(UNMANAGED);
  }, 180_000);

  it('an isolated install is managed too — its sessions survive the filter', () => {
    plantManagedVersion('0.146.0');
    fs.writeFileSync(path.join(home, '.agents', '.history', 'versions', 'codex', '0.146.0', '.isolated'), 'x\n');
    writeRollout(managedSessions('0.146.0'), MANAGED, home);

    const out = ids(run('--all', '-n', '50', '--json'));
    expect(out).toContain(MANAGED);
    expect(out).not.toContain(UNMANAGED);
  }, 180_000);
});
