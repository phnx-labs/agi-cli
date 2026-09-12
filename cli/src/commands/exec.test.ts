/**
 * Execution command helpers.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import {
  addAlwaysFreshRepo,
  computeNetMode,
  gitToplevel,
  hostTargetGiven,
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
        `require('fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({label:${JSON.stringify(label)}, codexHome:process.env.CODEX_HOME}));\n` +
        'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"OK"}}));\n' +
        'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}}));\n',
        { mode: 0o755 });
    }
    const credential = JSON.stringify({ tokens: { id_token: `fixture.${payload}.unsigned` } });
    fs.writeFileSync(path.join(authHome, '.codex', 'auth.json'), credential);
    // JSON is valid YAML; the actual state reader and native identity selector
    // are exercised, with non-secret local fixtures and no vendor request.
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), JSON.stringify({
      agents: { codex: binaryDefault },
      accounts: { native: { work: {
        id: 'work', name: 'work', agent: 'codex', scope: 'version',
        identityKey: 'codex:account=work:user=user1', identityLabel: 'work@example.com',
      } } },
    }));
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      for (const [spec, expectedBinary] of [['codex#work', accountLabel], [`codex@${binaryDefault}#work`, binaryDefault]]) {
        const result = spawnSync('node', ['--import', tsxImport,
          path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', spec, 'Reply OK',
          '--mode', 'skip', '--quiet', '--no-auto-secrets', '--cwd', root], {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, AGENTS_EVENTS_PATH: path.join(root, 'events.jsonl') },
          encoding: 'utf8', timeout: 60_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toEqual({
          label: expectedBinary, codexHome: path.join(authHome, '.codex'),
        });
        expect(fs.readFileSync(path.join(authHome, '.codex', 'auth.json'), 'utf8')).toBe(credential);
      }
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
    // Antigravity has no read-only plan mode, so --mode plan degrades to edit.
    // Cursor now supports plan (RUSH-2101), so it can no longer exercise this path.
    const agy = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
    fs.writeFileSync(
      agy,
      process.platform === 'win32'
        ? '@echo {"type":"result","subtype":"success","is_error":false,"result":"OK"}\r\n'
        : '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"OK"}\\n\'\n',
      { mode: 0o755 },
    );
    try {
      // `node` cannot resolve the CLI's `.js` ESM specifiers to .ts sources on its
      // own — spawn through the tsx loader, the same way every other CLI-spawning
      // test does (commands/routines.test.ts:19-26,75). `--import` needs a module
      // specifier, not a bare path, or Windows dies on ERR_UNSUPPORTED_ESM_URL_SCHEME.
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      // Vitest setup pins AGENTS_EVENTS_PATH to a fork-local sink; clear it so the
      // child writes under HOME (same pattern as tests/events-audit.test.ts).
      // New runs emit run.dispatched there — not the legacy audit/log.jsonl chain.
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
      // Antigravity has no plan mode — resolved writable mode must be edit.
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
    // The account picker chooses the version — a version pin conflicts.
    expect(parseRunPickerMarkers('claude@2.1.218#')).toMatchObject({ valid: false });
    // An explicit account label conflicts with the account picker.
    expect(parseRunPickerMarkers('claude#work#')).toMatchObject({ valid: false });
    // Same rule as today's claude@2.1.218@ for the device marker.
    expect(parseRunPickerMarkers('claude@2.1.218@')).toMatchObject({ valid: false });
    // Doubled markers are malformed.
    expect(parseRunPickerMarkers('claude##')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('claude@@')).toMatchObject({ valid: false });
    expect(parseRunPickerMarkers('claude#@#')).toMatchObject({ valid: false });
    // Markers with no agent at all.
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
    // `#` asks for the account; naming one as well is the same contradiction.
    expect(runAccountPickerConflicts({ account: 'work' })).toEqual(['--account work']);
  });

  it('rejects placement selectors alongside the device picker, but not account selectors', () => {
    expect(runDevicePickerConflicts({ device: 'worker-1' })).toEqual(['--device worker-1']);
    expect(runDevicePickerConflicts({ on: 'worker-1', computer: 'worker-2' }))
      .toEqual(['--device worker-1', '--device worker-2']);
    expect(runDevicePickerConflicts({ lease: true, box: 'warm-one' })).toEqual(['--lease', '--box']);
    expect(runDevicePickerConflicts({})).toEqual([]);
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
    // crabbox builds its sync file list with `git ls-files`, which exits 128
    // here; the guard must catch that before a box is provisioned and billed.
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
      // macOS /tmp symlinks to /private/tmp, and on Windows os.tmpdir() hands
      // back the 8.3 short form (C:\Users\RUNNER~1\...) while git reports the
      // long one — realpathSync.native normalizes both, plain realpathSync
      // only the symlink.
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
    expect(base).toEqual(['/repo/one']); // original untouched
    // Re-adding returns the SAME array reference (no duplicate).
    expect(addAlwaysFreshRepo(added, '/repo/two')).toBe(added);
  });
});

describe('hostTargetGiven — the --device routing flag family (the --terminal reject guard)', () => {
  // Regression: the --terminal handoff guard checked only `options.device`, so
  // `agents run <agent> --terminal --device box` (or --on/--computer) silently
  // opened a LOCAL tab and dropped the remote target instead of rejecting the
  // combination. Every alias must count as a host target.
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

  it('runAutoDefaultsToAffinity: a host-dispatched run never re-runs affinity (no chain-hopping)', () => {
    expect(runAutoDefaultsToAffinity({}, { AGENTS_RUN_AUTO_HOST_RESOLVED: '1' })).toBe(false);
  });

  it('the keyword does not collide with a real harness id today', () => {
    expect(RUN_AUTO_KEYWORD).toBe('auto');
    // If this ever fails, a harness registered the id `auto` and the run-auto
    // keyword must be renamed — the action fails loud on the collision.
    expect(ALL_AGENT_IDS).not.toContain('auto');
  });

  it('agents run auto with zero installed harnesses exits nonzero with the no-healthy contract message', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-auto-empty-'));
    try {
      // Fresh HOME → no installed harness versions → the harness layer finds
      // zero candidates and must fail loud instead of launching anything. The
      // .agents/.system fixture gets past the first-run setup gate (same shape
      // as the governance-mode test above).
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
      // The watchdog contract: literal `no healthy` + `resets` on the error line.
      expect(result.stderr).toContain('no healthy');
      expect(result.stderr).toContain('resets');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('interactive host dispatch — run auto session correlation (RUSH-2132 review #5)', () => {
  it('run auto ALWAYS mints a correlation launch id, even with an explicit --session-id', () => {
    // The harness is picked on the remote; the explicit id is only adopted by a
    // claude pick. Pre-registering it would strand a stale index entry when the
    // pick lands elsewhere — so the launch-id join must resolve the REAL id.
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
    // A profile's model comes from its endpoint (ANTHROPIC_MODEL), not the host
    // harness catalog. `--model cheap` used to resolve against the HOST harness
    // (claude -> claude-haiku-*) and forward that id to the profile's endpoint,
    // which doesn't ship it. The guard must discard the tier with a standout
    // warning BEFORE the host binary is spawned, leaving the profile's own model.
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
    // Fake `claude` host binary: record the model-bearing env + argv it was spawned
    // with (into $HOME/spawn.json), then emit a benign success line so the run ends.
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
      // The guard runs before any spawn, so the standout warning is the invariant.
      expect(result.stderr).toContain("cost tiers don't apply to custom harness 'kimiprofile'");
      // When the host binary is reached, it must carry the profile's own model, never
      // a claude tier id resolved from the host harness catalog.
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
    // Repro: `agents harness fork opencode oc-test --model openai/gpt-5.4-mini`
    // then `agents run oc-test` used to spawn `opencode run --agent plan …`
    // with no --model, so OpenCode fell back to its configured default.
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

/**
 * RUSH-2339 — `agents run <agent>` on a machine without that harness.
 *
 * Before the fix the launch fell through to the bare `cliCommand` and died as
 * `sh: 1: exec: cursor-agent: not found` (exit 127), after a `⚠ cursor looks
 * logged out` banner that was also wrong — it is not logged out, it is absent.
 *
 * These drive the REAL `agents run` command in a subprocess against a planted
 * HOME (`.agents/.system` git-inited so `ensureInitialized` passes) and a PATH
 * holding only what the test plants. No mocks: the second case genuinely
 * launches the harness stub, which is the whole point — a self-installed
 * harness with no version home MUST still run, so the guard cannot be a
 * "does agents-cli manage a version" check.
 */
describe.skipIf(process.platform === 'win32')('agents run — harness not installed (RUSH-2339)', () => {
  // Resolved lazily: the describe factory body runs even when skipIf skips the
  // block, so an eager lookup would fail collection on a box without bun.
  const bunBin = () => execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).trim();
  // Anchor on this file, not process.cwd() — vitest inherits the invoking shell's
  // cwd, so a run started from the repo root would not find src/index.ts.
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
      // The two wrong messages the bug produced must be gone.
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

/**
 * RUSH-2527 — `--copy-creds` must refuse immediately with exit 1.
 *
 * The flag was a credential-copy feature; it is now a deprecated refusal. Any
 * invocation that passes --copy-creds must print a clear error and exit 1
 * without launching an agent or copying anything.
 */
describe.skipIf(process.platform === 'win32')('--copy-creds refusal (RUSH-2527)', () => {
  const bunBin = () => execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).trim();
  const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  it('exits 1 and prints the refusal message — no agent launched', () => {
    // --copy-creds is only evaluated when a --device target is given (it was a
    // host-transfer feature). Pass --device with a dummy name; the refusal
    // must fire before any SSH or agent launch attempt.
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
