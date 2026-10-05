import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LocalHostProvider as LHP } from './local.js';

let home: string;
let provider: LHP;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function freshProvider(): Promise<LHP> {
  vi.resetModules();
  const { LocalHostProvider } = await import('./local.js');
  return new LocalHostProvider();
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hosts-test-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  provider = await freshProvider();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe('LocalHostProvider CRUD', () => {
  it('registers, lists, resolves, and removes an inline host', async () => {
    await provider.register!({ name: 's1', provider: 'local', source: 'inline', address: 'yosemite-s1', user: 'muqsit', caps: ['gpu'] });

    const listed = await provider.list();
    const s1 = listed.find((h) => h.name === 's1');
    expect(s1).toBeDefined();
    expect(s1!.source).toBe('inline');
    expect(s1!.address).toBe('yosemite-s1');
    expect(s1!.user).toBe('muqsit');
    expect(s1!.caps).toEqual(['gpu']);
    expect(s1!.enrolled).toBe(true);

    const resolved = await provider.resolve('s1');
    expect(resolved?.address).toBe('yosemite-s1');

    await provider.remove!('s1');
    expect(await provider.resolve('s1')).toBeNull();
    expect((await provider.list()).find((h) => h.name === 's1')).toBeUndefined();
  });

  it('persists across provider instances (written to agents.yaml)', async () => {
    await provider.register!({ name: 'box', provider: 'local', source: 'inline', address: '10.0.0.5' });
    const reloaded = await freshProvider();
    expect((await reloaded.resolve('box'))?.address).toBe('10.0.0.5');
  });
});

describe('LocalHostProvider ssh-config union + resolution order', () => {
  it('lists ssh-config hosts as available (not enrolled) and unions with inline', async () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host cfg-box\n  HostName 1.2.3.4\n  User me\n', 'utf-8');
    provider = await freshProvider();

    await provider.register!({ name: 'inline-box', provider: 'local', source: 'inline', address: '9.9.9.9' });

    const list = await provider.list();
    const cfg = list.find((h) => h.name === 'cfg-box');
    const inline = list.find((h) => h.name === 'inline-box');
    expect(cfg).toBeDefined();
    expect(cfg!.source).toBe('ssh-config');
    expect(cfg!.enrolled).toBe(false);
    expect(cfg!.address).toBeUndefined();
    expect(inline!.enrolled).toBe(true);

    expect((await provider.resolve('cfg-box'))?.source).toBe('ssh-config');
  });

  it('an inline overlay wins over an ssh-config host of the same name', async () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host dup\n  HostName 1.1.1.1\n', 'utf-8');
    provider = await freshProvider();
    await provider.register!({ name: 'dup', provider: 'local', source: 'inline', address: '2.2.2.2', caps: ['gpu'] });

    const resolved = await provider.resolve('dup');
    expect(resolved?.source).toBe('inline');
    expect(resolved?.address).toBe('2.2.2.2');
    expect(resolved?.caps).toEqual(['gpu']);
    expect((await provider.list()).filter((h) => h.name === 'dup')).toHaveLength(1);
  });
});

describe('LocalHostProvider device-scoping (PHNX-3315)', () => {
  const originalMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
  afterEach(() => {
    if (originalMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = originalMachineId;
  });

  it("registers into THIS box's device doc, never the shared central agents.yaml", async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'boxa';
    const p = await freshProvider();
    await p.register!({ name: 'h1', provider: 'local', source: 'inline', address: '10.0.0.9' });

    const doc = fs.readFileSync(path.join(home, '.agents', 'devices', 'boxa', 'agents.yaml'), 'utf-8');
    expect(doc).toContain('h1');
    expect(doc).toContain('10.0.0.9');
    const centralPath = path.join(home, '.agents', 'agents.yaml');
    const central = fs.existsSync(centralPath) ? fs.readFileSync(centralPath, 'utf-8') : '';
    expect(central).not.toContain('h1');
  });

  it("merges host registries across boxes on read, and remove only touches this box's doc", async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'boxa';
    const p = await freshProvider();
    await p.register!({ name: 'mine', provider: 'local', source: 'inline', address: 'a' });
    const peer = path.join(home, '.agents', 'devices', 'boxb', 'agents.yaml');
    fs.mkdirSync(path.dirname(peer), { recursive: true });
    fs.writeFileSync(peer, 'hosts:\n  theirs:\n    source: inline\n    address: b\n');

    const names = (await p.list()).map((h) => h.name).sort();
    expect(names).toContain('mine');
    expect(names).toContain('theirs');

    await p.remove!('theirs');
    await p.remove!('mine');
    expect((await p.list()).map((h) => h.name)).toContain('theirs');
    expect((await p.list()).map((h) => h.name)).not.toContain('mine');
    expect(fs.readFileSync(peer, 'utf-8')).toContain('theirs');
  });

  it("throws on a malformed hosts block in this box's own device doc rather than silently dropping it", async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'boxa';
    const doc = path.join(home, '.agents', 'devices', 'boxa', 'agents.yaml');
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, 'hosts:\n  - 1\n  - 2\n');
    const p = await freshProvider();
    await expect(p.list()).rejects.toThrow(/corrupted/);
  });
});
