import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Seeded registry presets (SEEDED_REGISTRIES) are resolved in memory by getRegistries, not written
// to agents.yaml: writing from the read path dirtied that tracked file and deadlocked `agents repo
// pull` (RUSH-1925). Each test points HOME at a throwaway dir and re-imports; no mocks.
let TMP = '';

async function freshRegistry() {
  vi.resetModules();
  return import('./registry.js');
}

function metaPath() {
  return path.join(TMP, '.agents', 'agents.yaml');
}

function writeMetaFile(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(metaPath(), yamlText);
}

describe('seeded registry presets', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-registry-seeds-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('offers hermes without writing it to agents.yaml', async () => {
    writeMetaFile('registries:\n  mcp: {}\n  skill: {}\n');
    const before = fs.readFileSync(metaPath(), 'utf-8');

    const { getRegistries } = await freshRegistry();
    expect(getRegistries('skill').hermes?.enabled).toBe(true);
    expect(fs.readFileSync(metaPath(), 'utf-8')).toBe(before);
  });

  it('stops offering a preset the user removed, and records the tombstone', async () => {
    writeMetaFile('registries:\n  mcp: {}\n  skill: {}\n');

    const { getRegistries, removeRegistry } = await freshRegistry();
    expect(removeRegistry('skill', 'hermes')).toBe(true);
    expect(fs.readFileSync(metaPath(), 'utf-8')).toContain('skill.hermes');
    expect(getRegistries('skill').hermes).toBeUndefined();

    // Sticky across a fresh process — the whole point of the tombstone.
    const { getRegistries: again } = await freshRegistry();
    expect(again('skill').hermes).toBeUndefined();
  });

  it('reports false when removing a preset that is already gone', async () => {
    writeMetaFile('registries:\n  mcp: {}\n  skill: {}\nseededPresets:\n  - skill.hermes\n');

    const { removeRegistry } = await freshRegistry();
    expect(removeRegistry('skill', 'hermes')).toBe(false);
  });

  it('keeps a pre-RUSH-1925 seeded entry, tombstone and all', async () => {
    // What the old read-path seeding left behind: the entry in the user's own
    // registries block AND the key in seededPresets. The explicit entry wins, so
    // upgrading must not make the registry vanish.
    writeMetaFile([
      'registries:',
      '  mcp: {}',
      '  skill:',
      '    hermes:',
      '      url: https://hermes-agent.nousresearch.com/docs/api/skills-index.json',
      '      enabled: true',
      'seededPresets:',
      '  - skill.hermes',
      '',
    ].join('\n'));

    const { getRegistries } = await freshRegistry();
    expect(getRegistries('skill').hermes?.enabled).toBe(true);
  });

  it('keeps the preset url when a partial update disables it', async () => {
    // A seeded preset has no stored entry to merge with, so setRegistry falls back to
    // SEEDED_REGISTRIES. Otherwise `registry disable` persisted only {enabled:false}, dropping
    // url, and the broken stored entry outranked the seed after re-enabling.
    writeMetaFile('registries:\n  mcp: {}\n  skill: {}\n');

    const { getRegistries, setRegistry } = await freshRegistry();
    const url = getRegistries('skill').hermes?.url;
    expect(url).toContain('hermes-agent.nousresearch.com');

    setRegistry('skill', 'hermes', { enabled: false });
    expect(getRegistries('skill').hermes).toEqual({ url, enabled: false });

    setRegistry('skill', 'hermes', { enabled: true });
    expect(getRegistries('skill').hermes).toEqual({ url, enabled: true });
  });

  it('lets a user override the preset config without being overwritten', async () => {
    writeMetaFile([
      'registries:',
      '  mcp: {}',
      '  skill:',
      '    hermes:',
      '      url: https://example.internal/skills.json',
      '      enabled: false',
      '',
    ].join('\n'));

    const { getRegistries } = await freshRegistry();
    const hermes = getRegistries('skill').hermes;
    expect(hermes?.url).toBe('https://example.internal/skills.json');
    expect(hermes?.enabled).toBe(false);
  });
});
