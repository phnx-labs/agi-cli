import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Meta } from '../types.js';
import { resolveLocalAccountLaunch } from './account-launch.js';
import { candidateAccountKey, type RotateCandidate } from './rotate.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function slotCandidate(name: string, id: string, version: string, slotDir: string): RotateCandidate {
  return {
    agent: 'codex',
    version,
    accountKey: `codex:account=${name}`,
    accountLabel: name,
    email: `${name}@example.test`,
    usageKey: `codex:account=${name}`,
    usageStatus: null,
    usageSnapshot: null,
    usageError: null,
    usageMinutesToLimit: null,
    plan: null,
    signedIn: true,
    authVerdict: 'live',
    lastActive: null,
    nativeAccount: name,
    nativeAccountId: id,
    slotDir,
    fromSlot: true,
  };
}

function accountMeta(rows: RotateCandidate[]): Pick<Meta, 'accounts' | 'deviceAccounts'> {
  return {
    accounts: {
      native: Object.fromEntries(rows.map((row) => [row.nativeAccountId!, {
        id: row.nativeAccountId!,
        name: row.nativeAccount!,
        agent: 'codex' as const,
        identityKey: row.accountKey!,
        identityLabel: row.email!,
        scope: 'device' as const,
      }])),
    },
    deviceAccounts: {
      slots: Object.fromEntries(rows.map((row) => [row.nativeAccountId!, {
        accountId: row.nativeAccountId!,
        slotDir: row.slotDir!,
        authMode: 'native' as const,
        verdict: 'live' as const,
      }])),
    },
  };
}

describe('resolveLocalAccountLaunch', () => {
  it('keeps two native slots on one executable distinct by account id and home', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-launch-'));
    roots.push(root);
    const slotA = path.join(root, 'slots', 'acct-a');
    const slotB = path.join(root, 'slots', 'acct-b');
    fs.mkdirSync(slotA, { recursive: true });
    fs.mkdirSync(slotB, { recursive: true });
    const a = slotCandidate('work', 'acct-a', 'codex-main', slotA);
    const b = slotCandidate('personal', 'acct-b', 'codex-main', slotB);
    const meta = accountMeta([a, b]);

    const [resolvedA, resolvedB] = await Promise.all([
      resolveLocalAccountLaunch({ agent: 'codex', executableVersion: 'codex-main', candidate: a, meta }),
      resolveLocalAccountLaunch({ agent: 'codex', executableVersion: 'codex-main', candidate: b, meta }),
    ]);

    expect(resolvedA).toMatchObject({ executableVersion: 'codex-main', execHome: slotA, account: { id: 'acct-a', key: 'native:acct-a' } });
    expect(resolvedB).toMatchObject({ executableVersion: 'codex-main', execHome: slotB, account: { id: 'acct-b', key: 'native:acct-b' } });
    expect(candidateAccountKey(a)).not.toBe(candidateAccountKey(b));
  });

  it('lets an executable change retain the selected account slot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-launch-version-'));
    roots.push(root);
    const slotDir = path.join(root, 'slot');
    fs.mkdirSync(slotDir, { recursive: true });
    const selected = slotCandidate('work', 'acct-work', 'old-binary', slotDir);

    const resolved = await resolveLocalAccountLaunch({
      agent: 'codex',
      executableVersion: 'new-binary',
      candidate: selected,
      meta: accountMeta([selected]),
    });

    expect(resolved.executableVersion).toBe('new-binary');
    expect(resolved.execHome).toBe(slotDir);
    expect(resolved.account).toMatchObject({ id: 'acct-work', name: 'work' });
  });
});
