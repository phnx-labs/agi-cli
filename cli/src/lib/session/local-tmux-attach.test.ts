import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveUniqueLocalLiveAliasBySuffix, shouldAttachLocalTmuxAliasBeforeFleet } from './local-tmux-attach.js';

function hasTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('resolveUniqueLocalLiveAliasBySuffix — bare 8-hex against LIVE local panes only (PHNX-3292)', () => {
  it('reports none when the socket has never had a server', async () => {
    const sock = path.join(os.tmpdir(), `agents-suffix-none-${process.pid}-${Date.now()}.sock`);
    expect(await resolveUniqueLocalLiveAliasBySuffix('0145ab8f', sock)).toEqual({ kind: 'none' });
  });

  it.skipIf(!hasTmux())('resolves the unique live pane, ignores a dead one, and fails closed on a collision', async () => {
    const sock = path.join(os.tmpdir(), `agents-suffix-live-${process.pid}-${Date.now()}.sock`);
    const uniqueLive = 'ag-claude-aa11bb22';
    const deadSameSuffix = 'ag-codex-cc33dd44';
    const collisionA = 'ag-claude-ee55ff66';
    const collisionB = 'ag-codex-ee55ff66';
    try {
      execFileSync('tmux', ['-S', sock, 'set-option', '-g', 'remain-on-exit', 'on', ';',
        'new-session', '-d', '-s', uniqueLive, 'sleep 300']);
      execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', deadSameSuffix, 'true']);
      execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', collisionA, 'sleep 300']);
      execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', collisionB, 'sleep 300']);
      await new Promise((r) => setTimeout(r, 700));

      expect(await resolveUniqueLocalLiveAliasBySuffix('aa11bb22', sock)).toEqual({ kind: 'alias', alias: uniqueLive });

      expect(await resolveUniqueLocalLiveAliasBySuffix('cc33dd44', sock)).toEqual({ kind: 'none' });

      const collision = await resolveUniqueLocalLiveAliasBySuffix('ee55ff66', sock);
      expect(collision.kind).toBe('collision');
      if (collision.kind === 'collision') {
        expect(collision.aliases.sort()).toEqual([collisionA, collisionB].sort());
      }

      expect(await resolveUniqueLocalLiveAliasBySuffix('00000000', sock)).toEqual({ kind: 'none' });
    } finally {
      try { execFileSync('tmux', ['-S', sock, 'kill-server']); } catch {  }
    }
  });
});

describe('shouldAttachLocalTmuxAliasBeforeFleet — re-exported from local-tmux-attach (PHNX-3292)', () => {
  it('is only true for an alias-shaped selector with no --device scope', () => {
    expect(shouldAttachLocalTmuxAliasBeforeFleet('ag-claude-0145ab8f', [])).toBe(true);
    expect(shouldAttachLocalTmuxAliasBeforeFleet('ag-claude-0145ab8f', ['zion'])).toBe(false);
    expect(shouldAttachLocalTmuxAliasBeforeFleet('0145ab8f', [])).toBe(false);
  });
});
