import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('bare interactive run addressability', () => {
  let home: string;
  let origHome: string | undefined;
  let childPid: number | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'addressability-'));
    process.env.HOME = home;

    const binDir = path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, 'claude');
    fs.writeFileSync(
      fakeClaude,
      '#!/usr/bin/env node\nprocess.title = \'claude\';\nconst fs = require(\'fs\');\nconst marker = process.env.AGENTS_ADDRESSABILITY_MARKER;\nif (marker) fs.writeFileSync(marker, String(process.pid));\nsetInterval(() => {}, 600000);\n',
    );
    fs.chmodSync(fakeClaude, 0o755);

    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });

    vi.resetModules();
  });

  afterEach(() => {
    if (childPid) {
      try { process.kill(childPid, 'SIGTERM'); } catch {}
      childPid = undefined;
    }
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('records an active session whose un-addressable failure carries a recovery hint', async () => {
    const marker = path.join(home, 'spawned.marker');

    const { execAgent } = await import('./exec.js');
    const { getActiveSessions } = await import('./session/active.js');
    const { readPidSessionEntry } = await import('./session/pid-registry.js');
    const { resolveInjectTargetForSession } = await import('./terminal/resolve.js');
    const { resolveAnswerRoute } = await import('./answer-router.js');

    const runPromise = execAgent({
      agent: 'claude',
      version: '9.9.9',
      mode: 'plan',
      effort: 'auto',
      env: { AGENTS_ADDRESSABILITY_MARKER: marker },
    });

    let spawnedPid: number | undefined;
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(marker)) {
        spawnedPid = Number(fs.readFileSync(marker, 'utf8'));
        if (spawnedPid > 0) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(spawnedPid).toBeDefined();
    expect(spawnedPid).toBeGreaterThan(0);
    childPid = spawnedPid;

    const entry = readPidSessionEntry(spawnedPid!);
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBeDefined();
    const sessionId = entry!.sessionId!;

    const sessions = await getActiveSessions();
    let found = sessions.find((s) => s.pid === spawnedPid);
    if (!found) {
      found = sessions.find((s) => s.sessionId === sessionId);
    }
    expect(found).toBeDefined();
    expect(found!.sessionId).toBe(sessionId);

    const ghosttySession = {
      ...found!,
      context: 'terminal' as const,
      host: 'ghostty',
      tty: found!.tty ?? 'pts/0',
      provenance: {
        host: 'ghostty',
        transport: 'local',
        mux: undefined,
        reply: null,
      },
    };
    const resolution = resolveInjectTargetForSession(ghosttySession);
    expect(resolution.addressable).toBe(false);
    if (!resolution.addressable) {
      expect(resolution.hint).toBeDefined();
      expect(resolution.hint).toContain('agents sessions resume');
      expect(resolution.hint).toContain('tmux');
    }

    const route = resolveAnswerRoute({
      mailboxId: sessionId,
      answer: 'keep going',
      block: {
        blockId: 'b1',
        sessionId,
        mailboxId: sessionId,
        host: 'zion',
        runtime: 'claude',
        ts: new Date().toISOString(),
        questions: [{ text: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      } as unknown as import('./feed/feed.js').OpenBlock,
      session: {
        ...ghosttySession,
        status: 'input_required',
        activity: 'waiting_input',
        awaitingReason: 'question',
      } as import('./session/active.js').ActiveSession,
    });
    expect(route.kind).toBe('refuse');
    if (route.kind === 'refuse') {
      expect(route.reason).toContain('no addressable terminal');
      expect(route.reason).toContain('agents sessions resume');
      expect(route.reason).toContain('tmux');
    }

    process.kill(spawnedPid!, 'SIGTERM');
    childPid = undefined;
    await runPromise;
  }, 30_000);
});
