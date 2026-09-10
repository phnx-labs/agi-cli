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

// A user dir long enough that every origin under it overflows SUN_LEN, the way
// a real `/Users/<name>/.agents` does once `.history/accounts/codex/<uuid>` or
// `.history/versions/codex/<v>/home` is appended.
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
    // The default version already lives in its short home and holds a login.
    fs.mkdirSync(path.dirname(versionHome), { recursive: true });
    const versionShort = resolveCodexHome(versionHome, agentsUserDir, VERSION, 'darwin');
    expect(versionShort).toBe(shortCodexHome(agentsUserDir, VERSION));
    fs.writeFileSync(path.join(versionShort, 'auth.json'), '{"who":"gmail"}');

    // The slot is a real directory with its own login, as `accounts add` leaves it.
    fs.mkdirSync(slotHome, { recursive: true });
    fs.writeFileSync(path.join(slotHome, 'auth.json'), '{"who":"getrush"}');

    const key = codexShortKey(slotHome, VERSION, historyDir);
    const slotShort = resolveCodexHome(slotHome, agentsUserDir, key, 'darwin');

    expect(slotShort).toBe(shortCodexHome(agentsUserDir, key));
    expect(slotShort).not.toBe(versionShort);
    // The key is what keeps a real `/Users/<name>/.agents/.codex-homes/<key>/.codex`
    // under SUN_LEN; the padded temp root here is deliberately longer than that.
    expect(key).toHaveLength('a-'.length + 12);
    // The login moved with the home and the slot path still resolves to it.
    expect(fs.readFileSync(path.join(slotShort, 'auth.json'), 'utf8')).toBe('{"who":"getrush"}');
    expect(fs.lstatSync(slotHome).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(slotHome, 'auth.json'), 'utf8')).toBe('{"who":"getrush"}');
    // The version's login is untouched.
    expect(fs.readFileSync(path.join(versionShort, 'auth.json'), 'utf8')).toBe('{"who":"gmail"}');
    // Idempotent on the next launch.
    expect(resolveCodexHome(slotHome, agentsUserDir, key, 'darwin')).toBe(slotShort);
  });

  it('refuses a short home that is not the link target of the origin', () => {
    // The pre-fix bug: a real origin directory and a short home owned by a different origin.
    const short = shortCodexHome(agentsUserDir, VERSION);
    fs.mkdirSync(short, { recursive: true });
    fs.writeFileSync(path.join(short, 'auth.json'), '{"who":"gmail"}');
    fs.mkdirSync(slotHome, { recursive: true });
    fs.writeFileSync(path.join(slotHome, 'auth.json'), '{"who":"getrush"}');

    expect(() => resolveCodexHome(slotHome, agentsUserDir, VERSION, 'darwin')).toThrow(/Refusing to run codex from/);
    // Nothing was moved or overwritten by the refusal.
    expect(fs.lstatSync(slotHome).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(short, 'auth.json'), 'utf8')).toBe('{"who":"gmail"}');
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
