import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addNativeAccount, readSlots, removeAccount } from '../account-registry.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from '../installations/store.js';
import { getVersionDir, invalidateInstalledVersionsCache, removeVersion } from '../installations/versions.js';
import { loadManifest } from '../staleness/index.js';
import { getHistoryDir, readMeta, updateMeta } from '../state.js';
import { ensureSlot, recordSlot, slotDir, syncResourcesToAccountSlots } from './slots.js';

describe('slotDir', () => {
  it('is ~/.agents/.history/accounts/<harness>/<accountId>/', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(slotDir('claude', id)).toBe(path.join(getHistoryDir(), 'accounts', 'claude', id));
  });

  it('refuses a path-shaped account id', () => {
    expect(() => slotDir('claude', '../escape')).toThrow(/Invalid account id/);
    expect(() => slotDir('claude', 'a/b')).toThrow(/Invalid account id/);
  });
});

describe('ensureSlot', () => {
  const id = `slot-test-${Date.now()}`;
  afterEach(() => {
    fs.rmSync(slotDir('claude', id), { recursive: true, force: true });
  });

  it('creates a HOME-shaped dir and does not copy credentials', () => {
    const slot = ensureSlot('claude', id);
    expect(slot.accountId).toBe(id);
    expect(slot.slotDir).toBe(slotDir('claude', id));
    expect(slot.authMode).toBe('native');
    expect(slot.verdict).toBe('unconfigured');
    expect(fs.existsSync(path.join(slot.slotDir, '.claude'))).toBe(true);

    const cred = path.join(slot.slotDir, '.claude', '.credentials.json');
    const oauth = path.join(slot.slotDir, '.claude.json');
    expect(fs.existsSync(cred)).toBe(false);
    if (fs.existsSync(oauth)) {
      const parsed = JSON.parse(fs.readFileSync(oauth, 'utf8')) as { oauthAccount?: unknown };
      expect(parsed.oauthAccount).toBeUndefined();
    }

    const version = getGlobalDefault('claude') ?? listInstalledVersions('claude')[0];
    if (version) {
      const fromHome = getVersionHomePath('claude', version);
      const srcSettings = path.join(fromHome, '.claude', 'settings.json');
      const destSettings = path.join(slot.slotDir, '.claude', 'settings.json');
      if (fs.existsSync(srcSettings)) {
        expect(fs.existsSync(destSettings)).toBe(true);
      }
      const srcCred = path.join(fromHome, '.claude', '.credentials.json');
      if (fs.existsSync(srcCred)) {
        expect(fs.existsSync(cred)).toBe(false);
      }
    }
  });

  it('is idempotent: a second call does not throw', () => {
    ensureSlot('claude', id);
    expect(() => ensureSlot('claude', id)).not.toThrow();
  });
});

describe('recordSlot / readSlots device-doc round-trip', () => {
  const prevMid = process.env.AGENTS_SYNC_MACHINE_ID;
  const clear = () => updateMeta((m) => ({
    ...m,
    accounts: { ...m.accounts, native: {} },
    deviceAccounts: undefined,
  }));
  beforeEach(() => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'slotbox';
    clear();
  });
  afterEach(() => {
    clear();
    if (prevMid === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMid;
  });

  it('persists slots in the device doc, never central, and round-trips', () => {
    const created = addNativeAccount('work', 'claude', 'claude:user=slot-1', 'work@example.com', 'version');
    const slot = ensureSlot('claude', created.id);
    recordSlot(created.id, slot);

    const read = readSlots(readMeta());
    expect(read[created.id]).toMatchObject({
      accountId: created.id,
      slotDir: slot.slotDir,
      authMode: 'native',
      verdict: 'unconfigured',
    });

    expect(readMeta().accounts).not.toHaveProperty('slots');
    expect(JSON.stringify(readMeta().accounts?.native?.[created.id] ?? {})).not.toContain('slotDir');

    removeAccount('work');
    expect(readSlots(readMeta())[created.id]).toBeUndefined();
    fs.rmSync(slot.slotDir, { recursive: true, force: true });
  });

  it('refuses a recordSlot key that does not match the slot', () => {
    expect(() => recordSlot('aaa', {
      accountId: 'bbb',
      slotDir: '/tmp/no',
      authMode: 'native',
      verdict: 'unconfigured',
    })).toThrow(/mismatch/);
  });
});

describe('syncResourcesToAccountSlots (single home-targeted writer, two accounts one binary)', () => {
  const suffix = `slotsync-${Date.now().toString(36)}`;
  const version = '2.1.0';
  const created: string[] = [];

  afterEach(() => {
    for (const name of created.splice(0)) {
      try { removeAccount(name); } catch { /* already gone */ }
    }
    const claudeAccounts = path.join(getHistoryDir(), 'accounts', 'claude');
    const codexAccounts = path.join(getHistoryDir(), 'accounts', 'codex');
    for (const root of [claudeAccounts, codexAccounts]) {
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles every materialized slot for the harness, skips other harnesses and unmaterialized slots, and never writes version-home staleness metadata into a slot', () => {
    const a = addNativeAccount(`a-${suffix}`, 'claude', `claude:user=a-${suffix}`, `a-${suffix}@example.com`, 'version');
    const b = addNativeAccount(`b-${suffix}`, 'claude', `claude:user=b-${suffix}`, `b-${suffix}@example.com`, 'version');
    const cx = addNativeAccount(`cx-${suffix}`, 'codex', `codex:user=cx-${suffix}`, `cx-${suffix}@example.com`, 'version');
    const ghost = addNativeAccount(`ghost-${suffix}`, 'claude', `claude:user=ghost-${suffix}`, `ghost-${suffix}@example.com`, 'version');
    created.push(a.name, b.name, cx.name, ghost.name);

    // a + b have real slot dirs; codex slot is materialized too (must still be
    // skipped, wrong harness); ghost has a slot RECORD but no dir on disk.
    recordSlot(a.id, ensureSlot('claude', a.id));
    recordSlot(b.id, ensureSlot('claude', b.id));
    recordSlot(cx.id, ensureSlot('codex', cx.id));
    recordSlot(ghost.id, { accountId: ghost.id, slotDir: slotDir('claude', ghost.id), authMode: 'native', verdict: 'unconfigured' });

    const results = syncResourcesToAccountSlots('claude', version, undefined, { force: true });
    const targeted = results.map((r) => r.accountId).sort();
    expect(targeted).toEqual([a.id, b.id].sort());
    expect(targeted).not.toContain(cx.id);
    expect(targeted).not.toContain(ghost.id);

    // The slot sync projects resources into the slot home but must NOT write the
    // version-home `.sync-manifest.json` staleness record — that stays scoped to
    // the managed installation (the isManagedVersionHome guard).
    expect(loadManifest('claude', version)).toBeNull();
    expect(fs.existsSync(path.join(slotDir('claude', a.id), '.sync-manifest.json'))).toBe(false);
  });
});

describe('binary lifecycle preserves account slots', () => {
  it('removeVersion trashes the binary but leaves the account slot intact', () => {
    const id = `lifecycle-${Date.now().toString(36)}`;
    const version = `0.0.0-lifecycle-${Date.now().toString(36)}`;
    const slot = ensureSlot('claude', id);
    fs.writeFileSync(path.join(slot.slotDir, '.claude.json'), JSON.stringify({ marker: id }));
    fs.writeFileSync(path.join(slot.slotDir, '.claude', '.credentials.json'), JSON.stringify({ token: id }));

    const vdir = getVersionDir('claude', version);
    fs.mkdirSync(path.join(vdir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(vdir, 'node_modules', '.bin', 'claude'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(vdir, 'package.json'), '{}');
    invalidateInstalledVersionsCache('claude');

    try {
      expect(removeVersion('claude', version)).toBe(true);
      // The binary install is gone; the account slot lives outside the version
      // tree (~/.agents/.history/accounts/…), so it is untouched, credential and all.
      expect(fs.existsSync(vdir)).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(slot.slotDir, '.claude.json'), 'utf8'))).toEqual({ marker: id });
      expect(fs.existsSync(path.join(slot.slotDir, '.claude', '.credentials.json'))).toBe(true);
    } finally {
      fs.rmSync(slot.slotDir, { recursive: true, force: true });
      const trash = path.join(getHistoryDir(), 'trash', 'versions', 'claude', version);
      if (fs.existsSync(trash)) fs.rmSync(trash, { recursive: true, force: true });
      invalidateInstalledVersionsCache('claude');
    }
  });
});
