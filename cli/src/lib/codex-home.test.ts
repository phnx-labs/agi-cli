import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_CONTROL_SOCKET_SUFFIX,
  SUN_LEN,
  codexShortKey,
  resolveCodexHome,
  shortCodexHome,
} from './codex-home.js';

const ACCOUNT_ID = 'e003a157-64fd-4899-92cc-ac7ca547586e';
const VERSION = '0.153.4';

function makeUserDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const pad = 'p'.repeat(Math.max(0, 40 - root.length));
  const dir = path.join(root, `agents-${pad}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('codex-home', () => {
  let agentsUserDir: string;
  let historyDir: string;
  let slotHome: string;
  let versionHome: string;

  beforeEach(() => {
    agentsUserDir = makeUserDir();
    historyDir = path.join(agentsUserDir, '.history');
    slotHome = path.join(historyDir, 'accounts', 'codex', ACCOUNT_ID, '.codex');
    versionHome = path.join(historyDir, 'versions', 'codex', VERSION, 'home', '.codex');
    expect(slotHome.length + CODEX_CONTROL_SOCKET_SUFFIX.length).toBeGreaterThan(SUN_LEN);
    expect(versionHome.length + CODEX_CONTROL_SOCKET_SUFFIX.length).toBeGreaterThan(SUN_LEN);
  });

  afterEach(() => {
    fs.rmSync(path.dirname(agentsUserDir), { recursive: true, force: true });
  });

  it('keys a version home by version and an account slot by account id', () => {
    expect(codexShortKey(versionHome, VERSION, historyDir)).toBe(VERSION);
    expect(codexShortKey(slotHome, VERSION, historyDir)).toBe(`a-${ACCOUNT_ID.slice(0, 12)}`);
    expect(codexShortKey('/somewhere/else/.codex', VERSION, historyDir)).toBe(VERSION);
  });

  it('gives an account slot its own short home instead of the version home that holds another login', () => {
    fs.mkdirSync(path.dirname(versionHome), { recursive: true });
    const versionShort = resolveCodexHome(versionHome, agentsUserDir, VERSION, 'darwin');
    expect(versionShort).toBe(shortCodexHome(agentsUserDir, VERSION));
    fs.writeFileSync(path.join(versionShort, 'auth.json'), '{"who":"gmail"}');

    fs.mkdirSync(slotHome, { recursive: true });
    fs.writeFileSync(path.join(slotHome, 'auth.json'), '{"who":"getrush"}');

    const key = codexShortKey(slotHome, VERSION, historyDir);
    const slotShort = resolveCodexHome(slotHome, agentsUserDir, key, 'darwin');

    expect(slotShort).toBe(shortCodexHome(agentsUserDir, key));
    expect(slotShort).not.toBe(versionShort);
    expect(key).toHaveLength('a-'.length + 12);
    expect(fs.readFileSync(path.join(slotShort, 'auth.json'), 'utf8')).toBe('{"who":"getrush"}');
    expect(fs.lstatSync(slotHome).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(slotHome, 'auth.json'), 'utf8')).toBe('{"who":"getrush"}');
    expect(fs.readFileSync(path.join(versionShort, 'auth.json'), 'utf8')).toBe('{"who":"gmail"}');
    expect(resolveCodexHome(slotHome, agentsUserDir, key, 'darwin')).toBe(slotShort);
  });

  it('adopts the short home on a reinstall instead of crashing (BLOCKER 1)', () => {
    const key = codexShortKey(versionHome, VERSION, historyDir);
    const short = shortCodexHome(agentsUserDir, key);
    fs.mkdirSync(short, { recursive: true });
    fs.writeFileSync(path.join(short, 'auth.json'), '{"who":"icloud"}');
    fs.mkdirSync(versionHome, { recursive: true });
    fs.writeFileSync(path.join(versionHome, 'skills.marker'), 'freshly-synced');

    const resolved = resolveCodexHome(versionHome, agentsUserDir, key, 'darwin');

    expect(resolved).toBe(short);
    expect(fs.readFileSync(path.join(short, 'auth.json'), 'utf8')).toBe('{"who":"icloud"}');
    expect(fs.lstatSync(versionHome).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(versionHome)).toBe(fs.realpathSync(short));
    const superseded = fs.readdirSync(path.dirname(versionHome)).find((n) => n.includes('.superseded-'));
    expect(superseded).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(versionHome), superseded!, 'skills.marker'), 'utf8')).toBe('freshly-synced');
    expect(resolveCodexHome(versionHome, agentsUserDir, key, 'darwin')).toBe(short);
  });

  it('repoints a slot mis-linked onto a foreign home instead of running it (BLOCKER 2)', () => {
    const foreign = shortCodexHome(agentsUserDir, VERSION);
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'auth.json'), '{"who":"gmail"}');
    fs.mkdirSync(path.dirname(slotHome), { recursive: true });
    fs.symlinkSync(foreign, slotHome);

    const key = codexShortKey(slotHome, VERSION, historyDir);
    const resolved = resolveCodexHome(slotHome, agentsUserDir, key, 'darwin');

    const ownShort = shortCodexHome(agentsUserDir, key);
    expect(resolved).toBe(ownShort);
    expect(fs.realpathSync(slotHome)).toBe(fs.realpathSync(ownShort));
    expect(fs.realpathSync(slotHome)).not.toBe(fs.realpathSync(foreign));
    expect(fs.readFileSync(path.join(foreign, 'auth.json'), 'utf8')).toBe('{"who":"gmail"}');
  });

  it('adopts an existing short home for an origin that does not exist yet', () => {
    const short = shortCodexHome(agentsUserDir, VERSION);
    fs.mkdirSync(short, { recursive: true });
    expect(resolveCodexHome(versionHome, agentsUserDir, VERSION, 'darwin')).toBe(short);
    expect(fs.realpathSync(versionHome)).toBe(fs.realpathSync(short));
  });

  it('leaves the origin alone off macOS', () => {
    expect(resolveCodexHome(slotHome, agentsUserDir, 'a-e003a157', 'linux')).toBe(slotHome);
    expect(fs.existsSync(path.join(agentsUserDir, '.codex-homes'))).toBe(false);
  });
});
