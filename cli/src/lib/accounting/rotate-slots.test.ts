import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addNativeAccount, removeAccount } from '../account-registry.js';
import { recordSlot, slotDir } from '../accounts/slots.js';
import { resolveManagedInstallation } from '../installations/store.js';
import { readMeta, updateMeta } from '../state.js';
import { collectRunCandidates, pickBalancedCandidate } from './rotate.js';

const suffix = `t5rot-${Date.now()}`;
const planted: string[] = [];
const names: string[] = [];

function writeClaudeCred(home: string, email: string) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        emailAddress: email,
        accountUuid: `acct-${email}`,
        organizationUuid: `org-${email}`,
        organizationType: 'claude_max',
      },
    }),
  );
  fs.writeFileSync(
    path.join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 86_400_000 } }),
  );
}

beforeEach(() => {
  process.env.AGENTS_SYNC_MACHINE_ID = 't5-rotate-box';
});

afterEach(() => {
  for (const n of names) {
    try { removeAccount(n); } catch {  }
  }
  names.length = 0;
  for (const p of planted) fs.rmSync(p, { recursive: true, force: true });
  planted.length = 0;
  updateMeta((m) => ({ ...m, deviceAccounts: { ...m.deviceAccounts, slots: {} } }));
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

describe('collectRunCandidates enumerates slots (PHNX-3940 T5)', () => {
  it.skipIf(!resolveManagedInstallation('claude'))(
    'includes live slots and excludes expired slots from balanced',
    async () => {
      const live = addNativeAccount(`live-${suffix}`, 'claude', `claude:user=t5-live-${suffix}`, 'live@example.com', 'version');
      const dead = addNativeAccount(`dead-${suffix}`, 'claude', `claude:user=t5-dead-${suffix}`, 'dead@example.com', 'version');
      names.push(live.name, dead.name);
      const liveDir = slotDir('claude', live.id);
      const deadDir = slotDir('claude', dead.id);
      planted.push(liveDir, deadDir);
      writeClaudeCred(liveDir, 'live@example.com');
      writeClaudeCred(deadDir, 'dead@example.com');
      recordSlot(live.id, { accountId: live.id, slotDir: liveDir, authMode: 'native', verdict: 'live' });
      recordSlot(dead.id, { accountId: dead.id, slotDir: deadDir, authMode: 'native', verdict: 'expired' });

      const candidates = await collectRunCandidates('claude');
      const liveRow = candidates.find((c) => c.nativeAccount === live.name);
      const deadRow = candidates.find((c) => c.nativeAccount === dead.name);
      expect(liveRow).toBeDefined();
      expect(liveRow?.fromSlot).toBe(true);
      expect(liveRow?.slotDir).toBe(liveDir);
      expect(liveRow?.authVerdict).toBe('live');
      expect(deadRow?.fromSlot).toBe(true);
      expect(deadRow?.authVerdict).toBe('expired');

      const picked = pickBalancedCandidate(candidates.filter((c) => c.fromSlot));
      expect(picked?.picked.nativeAccount).toBe(live.name);
      expect(picked?.excluded.some((c) => c.nativeAccount === dead.name)).toBe(true);
      expect(readMeta().deviceAccounts?.slots?.[live.id]?.slotDir).toBe(liveDir);
    },
  );
});
