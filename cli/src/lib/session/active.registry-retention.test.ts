import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-registry-'));
process.env.HOME = TEST_HOME;

const { listTerminalsActive, foldHostLink } = await import('./active.js');
const { HOST_HEARTBEAT_STALE_MS } = await import('./host-link.js');

const REGISTRY = path.join(TEST_HOME, '.agents', '.cache', 'terminals', 'live-terminals.json');
const DEAD_PID = 2_000_000_003;

function writeRegistry(windowAgeMs: number, pid: number): void {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  const at = new Date(Date.now() - windowAgeMs).toISOString();
  fs.writeFileSync(
    REGISTRY,
    JSON.stringify({
      'a-window': {
        at,
        entries: [
          { sessionId: 'sess-under-test', pid, kind: 'claude', cwd: TEST_HOME, startedAtMs: Date.now() },
        ],
      },
    }),
  );
}

describe('live-terminals retention for a crashed host', () => {
  beforeEach(() => {
    fs.rmSync(REGISTRY, { force: true });
  });

  it('keeps a dead-pid entry whose window stopped republishing, and reports it crashed', async () => {
    writeRegistry(HOST_HEARTBEAT_STALE_MS + 60_000, DEAD_PID);
    const rows = await listTerminalsActive();
    const row = rows.find((r) => r.sessionId === 'sess-under-test');
    expect(row, 'a crashed session must still reach the listing').toBeDefined();
    expect(row!.status).toBe('closed');
    foldHostLink(rows);
    expect(row!.status).toBe('crashed');
    expect(row!.hostLink).toBe('host-gone');
  });

  it('drops a dead-pid entry while its window is still republishing — an ordinary close', async () => {
    writeRegistry(30_000, DEAD_PID);
    const rows = await listTerminalsActive();
    expect(rows.find((r) => r.sessionId === 'sess-under-test')).toBeUndefined();
  });

  it('keeps a live entry regardless of the window heartbeat', async () => {
    writeRegistry(HOST_HEARTBEAT_STALE_MS + 60_000, process.pid);
    const rows = await listTerminalsActive();
    const row = rows.find((r) => r.sessionId === 'sess-under-test');
    expect(row).toBeDefined();
    expect(row!.status).not.toBe('closed');
  });

  it('carries the window heartbeat through so the fold can read it', async () => {
    writeRegistry(HOST_HEARTBEAT_STALE_MS + 60_000, process.pid);
    const rows = await listTerminalsActive();
    const row = rows.find((r) => r.sessionId === 'sess-under-test')!;
    expect(row.windowHeartbeatMs).toBeTypeOf('number');
    expect(Date.now() - row.windowHeartbeatMs!).toBeGreaterThanOrEqual(HOST_HEARTBEAT_STALE_MS);
  });

  it('carries the window folder as workspaceDir, apart from the agent cwd, so focus can raise that window', async () => {
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
    fs.writeFileSync(REGISTRY, JSON.stringify({
      'a-window': {
        at: new Date().toISOString(),
        entries: [{ sessionId: 'sess-under-test', terminalId: 'cl-1-1', pid: process.pid, kind: 'claude', cwd: TEST_HOME, startedAtMs: Date.now() }],
      },
    }));
    const row = (await listTerminalsActive()).find((r) => r.sessionId === 'sess-under-test')!;
    expect(row.workspaceDir).toBe(TEST_HOME);
    expect(row.terminalId).toBe('cl-1-1');
    expect(row.windowId).toBe('a-window');
  });
});
