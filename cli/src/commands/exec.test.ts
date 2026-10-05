import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import {
  addAlwaysFreshRepo,
  bareInteractiveRunDefaultsToDeviceAuto,
  computeNetMode,
  resolveRunCwd,
  gitToplevel,
  hostTargetGiven,
  pinLocalWhenTargetIsSelf,
  isAlwaysFreshRepo,
  isInsideGitWorkTree,
  parseRunPickerMarkers,
  runAccountPickerConflicts,
  runDevicePickerConflicts,
  runAutoDefaultsToAffinity,
  hostInteractiveNeedsCorrelationId,
  parseExplicitSessionId,
  RUN_AUTO_KEYWORD,
} from './exec.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { codexShortKey, shortCodexHome } from '../lib/codex-home.js';

describe('run working directory across a device boundary', () => {
  it.each(['$HOME', '~', '$HOME/project with spaces', '~/project with spaces'])(
    'preserves %s remotely and expands it only on the executing host', async (cwd) => {
      const remote = await resolveRunCwd({ cwd, addDir: [] }, { forRemote: true });
      expect(remote).toBe(cwd);
      const local = await resolveRunCwd({ cwd: remote, addDir: [] }, { forRemote: false });
      const expected = cwd.includes('/')
        ? path.join(process.env.HOME ?? os.homedir(), 'project with spaces')
        : process.env.HOME ?? os.homedir();
      expect(local).toBe(expected);
    },
  );
  it('leaves absent, relative, and absolute directories unchanged', async () => {
    for (const cwd of [undefined, 'relative/project', '/srv/project']) {
      expect(await resolveRunCwd({ cwd, addDir: [] }, { forRemote: false })).toBe(cwd);
    }
  });
});

describe.skipIf(process.platform === 'win32')('native account launch selects a stable home', () => {
  it('uses the account installation unless an explicit binary installation was requested', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-account-launch-'));
    const capturePath = path.join(root, 'launch.json');
    const accountLabel = '0.1.0';
    const binaryDefault = '0.2.0';
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    const payload = Buffer.from(JSON.stringify({
      email: 'work@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'work', chatgpt_user_id: 'user1' },
    })).toString('base64url');
    const authHome = path.join(root, '.agents', '.history', 'versions', 'codex', accountLabel, 'home');
    for (const label of [accountLabel, binaryDefault]) {
      const dir = path.join(root, '.agents', '.history', 'versions', 'codex', label);
      fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'home', '.codex'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'codex'),
        '#!/usr/bin/env node\n' +
        `if (process.argv.includes('--version')) { console.log('codex-cli ${label}'); process.exit(0); }\n` +
        `require('fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({label:${JSON.stringify(label)}, codexHome:process.env.CODEX_HOME,cwd:process.cwd()}));\n` +
        'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"OK"}}));\n' +
        'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}}));\n',
        { mode: 0o755 });
    }
    const credential = JSON.stringify({ tokens: { id_token: `fixture.${payload}.unsigned` } });
    fs.writeFileSync(path.join(authHome, '.codex', 'auth.json'), credential);
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), JSON.stringify({
      agents: { codex: binaryDefault },
      accounts: { native: { work: {
        id: 'work', name: 'work', agent: 'codex', scope: 'version',
        identityKey: 'codex:account=work:user=user1', identityLabel: 'work@example.com',
      } } },
    }));
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      for (const [spec, expectedBinary, cwd] of [['codex#work', accountLabel, '$HOME'], [`codex@${binaryDefault}#work`, binaryDefault, '~']]) {
        const result = spawnSync('node', ['--import', tsxImport,
          path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', spec, 'Reply OK',
          '--mode', 'skip', '--quiet', '--no-auto-secrets', '--cwd', cwd], {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, AGENTS_EVENTS_PATH: path.join(root, 'events.jsonl') },
          encoding: 'utf8', timeout: 60_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toEqual({
          label: expectedBinary, codexHome: path.join(authHome, '.codex'), cwd: fs.realpathSync(root),
        });
        expect(fs.readFileSync(path.join(authHome, '.codex', 'auth.json'), 'utf8')).toBe(credential);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 150_000);
});

describe.skipIf(process.platform === 'win32')('a balanced pick launches the picked account slot (PHNX-4116)', () => {
  it('spawns the binary with the picked slot as its home, not the version home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balanced-slot-launch-'));
    const capturePath = path.join(root, 'launch.json');
    const binaryDefault = '0.2.0';
    const accountId = 'acct-work';
    const slotDir = path.join(root, '.agents', '.history', 'accounts', 'codex', accountId);
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    const dir = path.join(root, '.agents', '.history', 'versions', 'codex', binaryDefault);
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'home', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'codex'),
      '#!/usr/bin/env node\n' +
      `if (process.argv.includes('--version')) { console.log('codex-cli ${binaryDefault}'); process.exit(0); }\n` +
      `require('fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({codexHome:process.env.CODEX_HOME}));\n` +
      'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"OK"}}));\n' +
      'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}}));\n',
      { mode: 0o755 });
    const payload = Buffer.from(JSON.stringify({
      email: 'work@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'work', chatgpt_user_id: 'user1' },
    })).toString('base64url');
    fs.mkdirSync(path.join(slotDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(slotDir, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: `fixture.${payload}.unsigned` } }));
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), JSON.stringify({ agents: { codex: binaryDefault } }));
    const deviceDir = path.join(root, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), JSON.stringify({
      accounts: {
        native: { [accountId]: {
          id: accountId, name: 'work', agent: 'codex', scope: 'device',
          identityKey: 'codex:account=work:user=user1', identityLabel: 'work@example.com',
        } },
        slots: { [accountId]: { accountId, slotDir, authMode: 'native', verdict: 'live' } },
      },
    }));
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync('node', ['--import', tsxImport,
        path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'codex', 'Reply OK',
        '--strategy', 'balanced', '--mode', 'skip', '--quiet', '--no-auto-secrets', '--cwd', '$HOME'], {
        cwd: path.resolve(import.meta.dirname, '..', '..'),
        env: { ...process.env, HOME: root, AGENTS_SYNC_MACHINE_ID: 'testbox', AGENTS_EVENTS_PATH: path.join(root, 'events.jsonl') },
        encoding: 'utf8', timeout: 60_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const rawHome = path.join(slotDir, '.codex');
      const shortHome = shortCodexHome(path.join(root, '.agents'), codexShortKey(rawHome, binaryDefault, path.join(root, '.agents', '.history')));
      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')).codexHome as string;
      expect([rawHome, shortHome], `captured ${captured}`).toContain(captured);
      expect(captured).not.toContain(path.join('codex', binaryDefault));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 150_000);
});

describe('--session-id CLI boundary (PHNX-3943)', () => {
  it('accepts UUIDs and conservative ASCII handles', () => {
    expect(parseExplicitSessionId('01a0555d-0675-78c1-9758-8214d1afdca2')).toBe('01a0555d-0675-78c1-9758-8214d1afdca2');
    expect(parseExplicitSessionId('session.name_1')).toBe('session.name_1');
  });

  it.each(['emoji-🚀', '会话', 'space id', 'slash/id', '#{session_name}', ''])('rejects %j', (value) => {
    expect(() => parseExplicitSessionId(value)).toThrow(
      'must contain only ASCII letters, digits, dots, underscores, or hyphens',
    );
  });
});

describe('degraded run governance mode', () => {
  it('records the resolved writable mode in the audit chain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-audit-mode-'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    const agy = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
    fs.writeFileSync(
      agy,
      process.platform === 'win32'
        ? '@echo {"type":"result","subtype":"success","is_error":false,"result":"OK"}\r\n'
        : '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"OK"}\\n\'\n',
      { mode: 0o755 },
    );
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const eventsPath = path.join(root, 'events.jsonl');
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'antigravity', 'probe', '--mode', 'plan', '--quiet', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: {
            ...process.env,
            HOME: root,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            AGENTS_EVENTS_PATH: eventsPath,
          },
          encoding: 'utf8',
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(eventsPath), `missing events at ${eventsPath}; stderr=${result.stderr}`).toBe(true);
      const rows = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const dispatched = rows.filter((r) => r.event === 'run.dispatched' && r.agent === 'antigravity');
      expect(dispatched.length, `events: ${JSON.stringify(rows.slice(-5))}`).toBeGreaterThanOrEqual(1);
      expect(dispatched.at(-1)).toMatchObject({
        agent: 'antigravity',
        mode: 'edit',
        outcome: 'ok',
        exitCode: 0,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('run picker markers (# account, @ device)', () => {
  it('parses each marker and strips them from the spec', () => {
    expect(parseRunPickerMarkers('claude')).toEqual({
      accountPicker: false,
      devicePicker: false,
      normalizedAgentSpec: 'claude',
      valid: true,
    });
    expect(parseRunPickerMarkers('claude#')).toEqual({
      accountPicker: true,
      devicePicker: false,
      normalizedAgentSpec: 'claude',
      valid: true,
    });
    expect(parseRunPickerMarkers('claude@')).toEqual({
      accountPicker: false,
      devicePicker: true,
      normalizedAgentSpec: 'claude',
      valid: true,
    });
    expect(parseRunPickerMarkers('claude#@')).toEqual({
      accountPicker: true,
      devicePicker: true,
      normalizedAgentSpec: 'claude',
      valid: true,
    });
    expect(parseRunPickerMarkers('claude@#')).toEqual({
      accountPicker: true,
      devicePicker: true,
      normalizedAgentSpec: 'claude',
      valid: true,
    });
  });

  it('keeps pins intact: no marker on a version pin or a labeled account', () => {
    expect(parseRunPickerMarkers('claude@2.1.218')).toMatchObject({
      accountPicker: false,
      devicePicker: false,
      normalizedAgentSpec: 'claude@2.1.218',
      valid: true,
    });
    expect(parseRunPickerMarkers('claude#work')).toMatchObject({
      accountPicker: false,
      devicePicker: false,
      normalizedAgentSpec: 'claude#work',
      valid: true,
    });
    expect(parseRunPickerMarkers('claude@2.1.218#work')).toMatchObject({
      normalizedAgentSpec: 'claude@2.1.218#work',
      valid: true,
    });
  });

  it('allows the device picker after an account label (#work@)', () => {
    expect(parseRunPickerMarkers('claude#work@')).toEqual({
      accountPicker: false,
      devicePicker: true,
      normalizedAgentSpec: 'claude#work',
      valid: true,
    });
  });

  it('rejects a pin combined with the picker for the same thing', () => {
    expect(parseRunPickerMarkers('claude@2.1.218#')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('claude#work#')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('claude@2.1.218@')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('claude##')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('claude@@')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('claude#@#')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('#')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('#@')).toMatchObject({ valid: false });
  });

  it('rejects selectors that would override the selected account but allows device routing', () => {
    expect(runAccountPickerConflicts({
      resume: true,
      strategy: 'balanced',
      balanced: true,
      lease: true,
      box: 'warm-one',
    })).toEqual(['--resume', '--strategy', '--balanced', '--lease', '--box']);
    expect(runAccountPickerConflicts({ device: 'worker-1' })).toEqual([]);
    expect(runAccountPickerConflicts({ account: 'work' })).toEqual(['--account work']);
  });

  it('rejects placement selectors alongside the device picker, but not account selectors', () => {
    expect(runDevicePickerConflicts({ device: 'worker-1' })).toEqual(['--device worker-1']);
    expect(runDevicePickerConflicts({ on: 'worker-1', computer: 'worker-2' }))
      .toEqual(['--device worker-1', '--device worker-2']);
    expect(runDevicePickerConflicts({ lease: true, box: 'warm-one' })).toEqual(['--lease', '--box']);
    expect(runDevicePickerConflicts({ local: true })).toEqual(['--local']);
    expect(runDevicePickerConflicts({})).toEqual([]);
  });
});

describe('pinLocalWhenTargetIsSelf — a --device naming this machine is a local run, not a self-SSH', () => {
  const isSelf = (name: string) => ['testbox', 'testbox.tail1a85a1.ts.net', 'localhost'].includes(name.toLowerCase());

  it.each([
    ['--device <short id>', { device: 'testbox' }],
    ['--host <MagicDNS name>', { host: 'TESTBOX.tail1a85a1.ts.net' }],
    ['--on localhost', { on: 'localhost' }],
    ['--computer <short id>', { computer: 'testbox' }],
  ])('%s clears the host flags and pins local', (_label, options) => {
    const o: { host?: string; device?: string; on?: string; computer?: string; local?: boolean } = { ...options };
    expect(pinLocalWhenTargetIsSelf(o, isSelf)).toBe(true);
    expect(hostTargetGiven(o)).toEqual([]);
    expect(o.local).toBe(true);
  });

  it('a peer, auto, or an empty host set is left for the dispatch path', () => {
    for (const options of [{ device: 'yosemite-s0' }, { device: 'auto' }, {}]) {
      const o: { device?: string; local?: boolean } = { ...options };
      expect(pinLocalWhenTargetIsSelf(o, isSelf)).toBe(false);
      expect(o.device).toBe(options.device);
      expect(o.local).toBeUndefined();
    }
  });
});

describe('isInsideGitWorkTree — the --lease/--box pre-flight sync guard', () => {
  it('is true inside a real git work tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-git-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q']);
      expect(isInsideGitWorkTree(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false in a plain directory that is not a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-nogit-'));
    try {
      expect(isInsideGitWorkTree(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitToplevel — always-fresh repo keying', () => {
  it('returns the absolute toplevel of a real repo, null outside one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-top-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q']);
      const top = gitToplevel(dir);
      expect(top).not.toBeNull();
      expect(fs.realpathSync.native(top!)).toBe(fs.realpathSync.native(dir));
      const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-notop-'));
      try {
        expect(gitToplevel(nogit)).toBeNull();
      } finally {
        fs.rmSync(nogit, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeNetMode — F5 tailscale vs public (RUSH-1924)', () => {
  it('a solo one-shot --lease (no reuse context) stays public', () => {
    expect(computeNetMode({ tailscale: undefined, reuseContext: false })).toBe('public');
  });

  it('a reuse context (--reuse/--box/picked box) defaults to the tailnet', () => {
    expect(computeNetMode({ tailscale: undefined, reuseContext: true })).toBe('tailscale');
  });

  it('--tailscale forces the tailnet even without a reuse context', () => {
    expect(computeNetMode({ tailscale: true, reuseContext: false })).toBe('tailscale');
  });

  it('--no-tailscale forces public even in a reuse context', () => {
    expect(computeNetMode({ tailscale: false, reuseContext: true })).toBe('public');
  });
});

describe('always-fresh repo set (F3 picker "remember for this repo")', () => {
  it('membership check is exact-path', () => {
    expect(isAlwaysFreshRepo(['/a/b'], '/a/b')).toBe(true);
    expect(isAlwaysFreshRepo(['/a/b'], '/a/c')).toBe(false);
    expect(isAlwaysFreshRepo([], '/a/b')).toBe(false);
  });

  it('add is idempotent and immutable', () => {
    const base = ['/repo/one'];
    const added = addAlwaysFreshRepo(base, '/repo/two');
    expect(added).toEqual(['/repo/one', '/repo/two']);
    expect(base).toEqual(['/repo/one']);
    expect(addAlwaysFreshRepo(added, '/repo/two')).toBe(added);
  });
});

describe('hostTargetGiven — the --device routing flag family (the --terminal reject guard)', () => {
  it('detects each --device alias, not just --device', () => {
    expect(hostTargetGiven({ host: 'box' })).toEqual(['box']);
    expect(hostTargetGiven({ device: 'box' })).toEqual(['box']);
    expect(hostTargetGiven({ on: 'box' })).toEqual(['box']);
    expect(hostTargetGiven({ computer: 'box' })).toEqual(['box']);
  });

  it('is empty when no host target is given (a local --terminal run is allowed)', () => {
    expect(hostTargetGiven({})).toEqual([]);
    expect(hostTargetGiven({ host: undefined })).toEqual([]);
  });

  it('returns every target when several aliases are set at once', () => {
    expect(hostTargetGiven({ host: 'a', device: 'b', on: 'c', computer: 'd' })).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('agents run auto — the reserved harness keyword (RUSH-2132)', () => {
  it('runAutoDefaultsToAffinity: no host flag → affinity default; any host flag pins the host layer', () => {
    expect(runAutoDefaultsToAffinity({})).toBe(true);
    expect(runAutoDefaultsToAffinity({ host: 'yosemite-s0' })).toBe(false);
    expect(runAutoDefaultsToAffinity({ device: 'yosemite-s0' })).toBe(false);
    expect(runAutoDefaultsToAffinity({ on: 'yosemite-s0' })).toBe(false);
    expect(runAutoDefaultsToAffinity({ computer: 'yosemite-s0' })).toBe(false);
  });

  it('runAutoDefaultsToAffinity: an explicit local pin is a decided host layer — run auto never overrides it with auto', () => {
    expect(runAutoDefaultsToAffinity({ local: true })).toBe(false);
  });

  it('runAutoDefaultsToAffinity: a host-dispatched run never re-runs affinity (no chain-hopping)', () => {
    expect(runAutoDefaultsToAffinity({}, { AGENTS_RUN_AUTO_HOST_RESOLVED: '1' })).toBe(false);
  });

  it('runAutoDefaultsToAffinity: an interactive dispatch of a NAMED harness is already placed too (PHNX-4083)', () => {
    expect(runAutoDefaultsToAffinity({}, { AGENTS_REMOTE_INTERACTIVE: '1' })).toBe(false);
    expect(runAutoDefaultsToAffinity({}, {
      AGENTS_RUN_AUTO_HOST_RESOLVED: '1',
      AGENTS_REMOTE_INTERACTIVE: '1',
    })).toBe(false);
  });

  it('the keyword does not collide with a real harness id today', () => {
    expect(RUN_AUTO_KEYWORD).toBe('auto');
    expect(ALL_AGENT_IDS).not.toContain('auto');
  });

  it('agents run auto with zero installed harnesses exits nonzero with the no-healthy contract message', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-auto-empty-'));
    try {
      fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'auto', 'probe', '--mode', 'plan', '--quiet', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no healthy');
      expect(result.stderr).toContain('resets');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bare interactive run defaults to --device auto (PHNX-4083)', () => {
  const bare = {};
  const human = { prompt: undefined, devicePickerRequested: false };
  const tty = { tty: true, json: false };

  it('a bare human-facing run with nothing pinned places automatically', () => {
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, human, tty)).toBe(true);
  });

  it('a prompt makes the run headless — it runs in place, unchanged', () => {
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, { ...human, prompt: 'fix the bug' }, tty)).toBe(false);
  });

  it('the human-facing gate is two conditions: a real TTY and no --json', () => {
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, human, { tty: true, json: true })).toBe(false);
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, human, { tty: false, json: false })).toBe(false);
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, human, { tty: false, json: true })).toBe(false);
  });

  it('the @ device-picker marker is an explicit device choice — never overridden', () => {
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, { ...human, devicePickerRequested: true }, tty)).toBe(false);
  });

  it('--local (and --where local, --device <this machine>, which pin the same field) is an explicit local choice', () => {
    expect(bareInteractiveRunDefaultsToDeviceAuto({ ...bare, local: true }, human, tty)).toBe(false);
    const pinned: { device?: string; local?: boolean } = { device: 'testbox' };
    pinLocalWhenTargetIsSelf(pinned, (n) => n === 'testbox');
    expect(runAutoDefaultsToAffinity(pinned)).toBe(false);
    expect(bareInteractiveRunDefaultsToDeviceAuto({ ...bare, ...pinned }, human, tty)).toBe(false);
  });

  it.each([
    ['--resume', { resume: 'abc123' }],
    ['--lease', { lease: true }],
    ['--box', { box: 'warm-one' }],
    ['--cloud', { cloud: true }],
  ])('%s owns placement outright', (_flag, options) => {
    expect(bareInteractiveRunDefaultsToDeviceAuto({ ...bare, ...options }, human, tty)).toBe(false);
  });

  it.each([
    ['--host', { host: 'yosemite-s0' }],
    ['--device', { device: 'yosemite-s0' }],
    ['--on', { on: 'yosemite-s0' }],
    ['--computer', { computer: 'yosemite-s0' }],
  ])('an explicit %s keeps the run where it was pointed', (_flag, options) => {
    expect(bareInteractiveRunDefaultsToDeviceAuto({ ...bare, ...options }, human, tty)).toBe(false);
  });

  it('a dispatched hop never re-places — neither run-auto nor interactive-dispatch markers', () => {
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, human, tty, { AGENTS_RUN_AUTO_HOST_RESOLVED: '1' })).toBe(false);
    expect(bareInteractiveRunDefaultsToDeviceAuto(bare, human, tty, { AGENTS_REMOTE_INTERACTIVE: '1' })).toBe(false);
  });

  it('stays a plain local run when several exclusions hold at once', () => {
    expect(bareInteractiveRunDefaultsToDeviceAuto(
      { resume: 'abc123', host: 'yosemite-s0' },
      { prompt: 'x', devicePickerRequested: true },
      { tty: false, json: true },
      { AGENTS_REMOTE_INTERACTIVE: '1' },
    )).toBe(false);
  });
});


describe('interactive host dispatch — run auto session correlation (RUSH-2132 review #5)', () => {
  it('run auto ALWAYS mints a correlation launch id, even with an explicit --session-id', () => {
    expect(hostInteractiveNeedsCorrelationId('auto', 'explicit-id', undefined)).toBe(true);
    expect(hostInteractiveNeedsCorrelationId('auto', undefined, undefined)).toBe(true);
  });

  it('resume never mints (the id is already known), for auto and named harnesses alike', () => {
    expect(hostInteractiveNeedsCorrelationId('auto', 'explicit-id', 'resume-id')).toBe(false);
    expect(hostInteractiveNeedsCorrelationId('claude', undefined, 'resume-id')).toBe(false);
  });

  it('named harnesses keep the existing matrix: claude trusts its forced id, tracked agents join, untracked skip', () => {
    expect(hostInteractiveNeedsCorrelationId('claude', 'forced-id', undefined)).toBe(false);
    expect(hostInteractiveNeedsCorrelationId('codex', undefined, undefined)).toBe(true);
    expect(hostInteractiveNeedsCorrelationId('amp', undefined, undefined)).toBe(false);
  });
});

describe('cost tier on a profile run is discarded, not resolved against the host harness', () => {
  it('warns loud and drops the tier so the host-harness catalog model never reaches the profile endpoint', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-profile-tier-'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.writeFileSync(
      path.join(root, '.agents', 'profiles', 'kimiprofile.yml'),
      [
        'name: kimiprofile',
        'host:',
        '  agent: claude',
        'env:',
        '  ANTHROPIC_MODEL: kimi-k2-thinking',
        '  ANTHROPIC_BASE_URL: https://example.invalid',
        'provider: claude',
        'forkedFrom: claude',
        '',
      ].join('\n'),
    );
    const spawnLog = path.join(root, 'spawn.json');
    const claudeBin = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    fs.writeFileSync(
      claudeBin,
      process.platform === 'win32'
        ? '@echo {"type":"result","subtype":"success","is_error":false,"result":"OK"}\r\n'
        : '#!/bin/sh\n'
          + 'node -e \'require("fs").writeFileSync(process.env.HOME + "/spawn.json", JSON.stringify({argv: process.argv.slice(2), model: process.env.ANTHROPIC_MODEL}))\'\n'
          + 'printf \'{"type":"result","subtype":"success","is_error":false,"result":"OK"}\\n\'\n',
      { mode: 0o755 },
    );
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'kimiprofile', 'probe', '--model', 'cheap', '--mode', 'plan', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      expect(result.stderr).toContain("cost tiers don't apply to custom harness 'kimiprofile'");
      if (fs.existsSync(spawnLog)) {
        const spawned = JSON.parse(fs.readFileSync(spawnLog, 'utf8')) as { argv: string[]; model?: string };
        expect(spawned.model).toBe('kimi-k2-thinking');
        expect(JSON.stringify(spawned.argv)).not.toMatch(/claude-(haiku|sonnet|opus)/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('custom harness names take precedence over native agent ids', () => {
  it('runs a custom harness named after a native id through its configured host', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-profile-native-name-'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.writeFileSync(
      path.join(root, '.agents', 'profiles', 'claude.yml'),
      [
        'name: claude',
        'host:',
        '  agent: opencode',
        'provider: openrouter',
        'env:',
        '  OPENCODE_MODEL: deepseek/deepseek-v3.2',
        '',
      ].join('\n'),
    );
    const opencode = path.join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    fs.writeFileSync(
      opencode,
      process.platform === 'win32'
        ? '@echo OK\r\n'
        : '#!/bin/sh\nprintf "OK\\n"\n',
      { mode: 0o755 },
    );
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'claude', 'probe', '--mode', 'plan', '--quiet', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("Resolved custom harness 'claude' -> opencode");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs a custom harness named after a hard-deprecated native id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-profile-deprecated-name-'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.writeFileSync(
      path.join(root, '.agents', 'profiles', 'gemini.yml'),
      [
        'name: gemini',
        'host:',
        '  agent: opencode',
        'provider: openrouter',
        'env:',
        '  OPENCODE_MODEL: deepseek/deepseek-v3.2',
        '',
      ].join('\n'),
    );
    const opencode = path.join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    fs.writeFileSync(
      opencode,
      process.platform === 'win32'
        ? '@echo OK\r\n'
        : '#!/bin/sh\nprintf "OK\\n"\n',
      { mode: 0o755 },
    );
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'gemini', 'probe', '--mode', 'plan', '--quiet', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("Resolved custom harness 'gemini' -> opencode");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('opencode custom harness emits --model for its pinned model (PHNX-2577)', () => {
  it('agents run <opencode-harness> includes --model <pin> on the host argv', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-opencode-model-'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.writeFileSync(
      path.join(root, '.agents', 'profiles', 'oc-test.yml'),
      [
        'name: oc-test',
        'host:',
        '  agent: opencode',
        'env:',
        '  OPENCODE_MODEL: openai/gpt-5.4-mini',
        '',
      ].join('\n'),
    );
    const spawnLog = path.join(root, 'spawn.json');
    const opencode = path.join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    fs.writeFileSync(
      opencode,
      process.platform === 'win32'
        ? '@echo {"type":"result","subtype":"success","is_error":false,"result":"OK"}\r\n'
        : '#!/usr/bin/env node\n'
          + 'require("fs").writeFileSync(process.env.HOME + "/spawn.json", JSON.stringify({argv: process.argv.slice(2)}));\n'
          + 'process.stdout.write(\'{"type":"result","subtype":"success","is_error":false,"result":"OK"}\\n\');\n',
      { mode: 0o755 },
    );
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'oc-test', 'hi', '--mode', 'plan', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("Resolved custom harness 'oc-test' -> opencode");
      expect(result.stderr).toMatch(/Running:.*--model openai\/gpt-5\.4-mini/);
      expect(fs.existsSync(spawnLog), `missing spawn log; stderr=${result.stderr}`).toBe(true);
      const spawned = JSON.parse(fs.readFileSync(spawnLog, 'utf8')) as { argv: string[] };
      const modelIdx = spawned.argv.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(spawned.argv[modelIdx + 1]).toBe('openai/gpt-5.4-mini');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('agents run — harness not installed (RUSH-2339)', () => {
  const bunBin = () => execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).trim();
  const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  function runAgentsRun(home: string, pathDir: string) {
    return spawnSync(bunBin(), [path.join(appRoot, 'src', 'index.ts'), 'run', 'cursor', 'hi', '--mode', 'plan', '--quiet'], {
      cwd: appRoot,
      env: { ...process.env, HOME: home, PATH: [pathDir, '/usr/bin', '/bin'].join(path.delimiter) },
      encoding: 'utf-8',
      timeout: 60_000,
    });
  }

  function plantHome(): { home: string; pathDir: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-not-installed-home-'));
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-not-installed-path-'));
    fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
    execFileSync('git', ['-C', path.join(home, '.agents', '.system'), 'init', '-q']);
    return { home, pathDir };
  }

  it('fails loud with an actionable message instead of exiting 127', () => {
    const { home, pathDir } = plantHome();
    try {
      const res = runAgentsRun(home, pathDir);
      const out = `${res.stdout}${res.stderr}`;

      expect(res.status).toBe(1);
      expect(res.status).not.toBe(127);
      expect(out).toContain('cursor is not installed on this machine');
      expect(out).toContain('agents add cursor');
      expect(out).not.toContain('looks logged out');
      expect(out).not.toContain('not found');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it('still launches a harness installed manually on PATH with no version home', () => {
    const { home, pathDir } = plantHome();
    try {
      const stub = path.join(pathDir, 'cursor-agent');
      fs.writeFileSync(stub, '#!/bin/sh\necho STUB_CURSOR_RAN\nexit 0\n');
      fs.chmodSync(stub, 0o755);
      expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'cursor'))).toBe(false);

      const res = runAgentsRun(home, pathDir);
      const out = `${res.stdout}${res.stderr}`;

      expect(out).toContain('STUB_CURSOR_RAN');
      expect(out).not.toContain('is not installed on this machine');
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('--copy-creds refusal (RUSH-2527)', () => {
  const bunBin = () => execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).trim();
  const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  it('exits 1 and prints the refusal message — no agent launched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-creds-'));
    try {
      fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
      const result = spawnSync(
        bunBin(),
        [path.join(appRoot, 'src', 'index.ts'), 'run', 'claude', '--device', 'dummy-device', '--copy-creds', '--mode', 'plan', 'probe'],
        {
          cwd: appRoot,
          env: { ...process.env, HOME: root },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain('Refusing --copy-creds');
      expect(`${result.stdout}${result.stderr}`).toContain('agents accounts sync');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
