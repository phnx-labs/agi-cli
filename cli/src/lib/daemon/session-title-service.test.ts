/**
 * The session-title service (PHNX-3797) against a REAL session index: only the
 * model call is injected. The property under test is cost containment — a box
 * with no usable harness must stop spawning one subprocess per session every two
 * minutes, and must resume the moment generation works again.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-titlesvc-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('../session/db.js');
const { SessionTitleService } = await import('./session-title-service.js');
const { machineId } = await import('../session/sync/config.js');
import type { DaemonContext } from './service.js';

function ctx(): DaemonContext {
  return { log: () => {} };
}

function seed(id: string, firstUserMessage: string): void {
  db.upsertSession({
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-09-01T10:00:00.000Z',
    lastActivity: new Date().toISOString(),
    filePath: `/tmp/${id}.jsonl`,
    machine: machineId(),
    topic: firstUserMessage.slice(0, 40),
    firstUserMessage,
  } as never, firstUserMessage);
}

describe('SessionTitleService', () => {
  it('titles pending sessions, then goes quiet once every recent row is current', async () => {
    seed('aaaa1111-0000-0000-0000-000000000001', 'Fix the fleet list headline so it names the work.');
    let calls = 0;
    const svc = new SessionTitleService(async () => { calls++; return 'Fleet headline fix'; });
    await svc.start(ctx());

    await svc.tick(ctx(), new AbortController().signal);
    expect(calls).toBe(1);
    expect(db.getSessionById('aaaa1111-0000-0000-0000-000000000001')?.generatedTitle).toBe('Fleet headline fix');

    // Steady state: no candidate, so no model call at all — never per-tick.
    await svc.tick(ctx(), new AbortController().signal);
    expect(calls).toBe(1);
    await svc.stop();
  });

  it('backs off after a failed sweep instead of respawning every tick, and recovers on success', async () => {
    seed('bbbb2222-0000-0000-0000-000000000002', 'Make the daemon own session titles.');
    let calls = 0;
    let fail = true;
    const svc = new SessionTitleService(async () => {
      calls++;
      if (fail) throw new Error('no signed-in harness');
      return 'Daemon owns session titles';
    });
    await svc.start(ctx());

    await svc.tick(ctx(), new AbortController().signal);
    expect(calls).toBe(1);

    // The next tick is skipped by the backoff — the whole point.
    await svc.tick(ctx(), new AbortController().signal);
    expect(calls).toBe(1);
    await svc.tick(ctx(), new AbortController().signal);
    expect(calls).toBe(1);

    // Backoff elapsed: one more attempt, which now succeeds.
    fail = false;
    await svc.tick(ctx(), new AbortController().signal);
    expect(calls).toBe(2);
    expect(db.getSessionById('bbbb2222-0000-0000-0000-000000000002')?.generatedTitle)
      .toBe('Daemon owns session titles');

    // A success clears the backoff: the next pending session is attempted at once.
    seed('cccc3333-0000-0000-0000-000000000003', 'Publish the title on the fleet mirror too.');
    await svc.tick(ctx(), new AbortController().signal);
    expect(calls).toBe(3);
    await svc.stop();
  });
});
