import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateMonitor,
  parseInterval,
  monitorRunsOnThisDevice,
  requiresSingleOwner,
  resolveSharedInputOwner,
  writeMonitor,
  readMonitor,
  deleteMonitor,
  listMonitors,
  setMonitorEnabled,
  getMonitorPath,
  type MonitorConfig,
} from './config.js';
import { machineId } from '../machine-id.js';
import { getMonitorsDir, getSystemMonitorsDir } from '../state.js';
import * as state from '../state.js';

/** Minimal valid monitor: poll a command, on-change, notify. */
function base(partial: Partial<MonitorConfig> = {}): Partial<MonitorConfig> {
  return {
    name: 'm',
    enabled: true,
    source: { type: 'poll', command: 'echo hi', interval: '30s' },
    condition: { mode: 'on-change' },
    action: { type: 'notify', notifyChannel: 'telegram' },
    ...partial,
  };
}

describe('validateMonitor — source/action requirements', () => {
  it('accepts a minimal valid monitor', () => {
    expect(validateMonitor(base())).toEqual([]);
  });

  it('accepts a custom harness (profile) name as the run action agent (RUSH-2930)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitors-harness-'));
    fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'profiles', 'deepseek.yml'),
      'name: deepseek\nhost:\n  agent: claude\nenv:\n  ANTHROPIC_MODEL: deepseek/deepseek-chat-v3-0324\n',
    );
    const spy = vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(dir);
    try {
      expect(validateMonitor(base({ action: { type: 'run', agent: 'deepseek', prompt: 'go' } }))).toEqual([]);
      const errors = validateMonitor(base({ action: { type: 'run', agent: 'no-such-harness', prompt: 'go' } }));
      expect(errors.some((e) => e.startsWith('action.agent must be one of:'))).toBe(true);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a monitor with no source', () => {
    const errors = validateMonitor(base({ source: undefined }));
    expect(errors.some((e) => /a source is required/.test(e))).toBe(true);
  });

  it('rejects a monitor with two sources (conflicting fields)', () => {
    const errors = validateMonitor(
      base({ source: { type: 'poll', command: 'echo hi', interval: '30s', url: 'https://x.test' } }),
    );
    expect(errors.some((e) => /conflicting fields/.test(e))).toBe(true);
  });

  it('rejects a monitor with no action', () => {
    const errors = validateMonitor(base({ action: undefined }));
    expect(errors.some((e) => /an action is required/.test(e))).toBe(true);
  });

  it('rejects a monitor with two actions (conflicting fields)', () => {
    const errors = validateMonitor(
      base({ action: { type: 'run', agent: 'claude', prompt: 'x', routine: 'other' } }),
    );
    expect(errors.some((e) => /conflicting fields/.test(e))).toBe(true);
  });

  it('rejects match-mode without condition.match', () => {
    const errors = validateMonitor(base({ condition: { mode: 'match' } }));
    expect(errors.some((e) => /requires condition\.match/.test(e))).toBe(true);
  });

  it('accepts match-mode with a match regex', () => {
    expect(validateMonitor(base({ condition: { mode: 'match', match: 'fail' } }))).toEqual([]);
  });

  it('rejects an invalid match regex', () => {
    const errors = validateMonitor(base({ condition: { mode: 'match', match: '([' } }));
    expect(errors.some((e) => /not a valid regular expression/.test(e))).toBe(true);
  });

  it('rejects a poll source with no interval', () => {
    const errors = validateMonitor(base({ source: { type: 'poll', command: 'echo hi' } }));
    expect(errors.some((e) => /requires source\.interval/.test(e))).toBe(true);
  });

  it('rejects poll-http without a url (wrong field for the type)', () => {
    const errors = validateMonitor(base({ source: { type: 'poll-http', command: 'echo', interval: '1m' } }));
    expect(errors.some((e) => /requires source\.url|conflicting fields/.test(e))).toBe(true);
  });

  it('rejects a run action without a prompt', () => {
    const errors = validateMonitor(base({ action: { type: 'run', agent: 'claude' } }));
    expect(errors.some((e) => /requires action\.prompt/.test(e))).toBe(true);
  });

  it('rejects a run action with an unknown agent', () => {
    const errors = validateMonitor(base({ action: { type: 'run', agent: 'nope' as never, prompt: 'x' } }));
    expect(errors.some((e) => /action\.agent must be one of/.test(e))).toBe(true);
  });

  it('rejects device + devices together', () => {
    const errors = validateMonitor(base({ device: 'a', devices: ['b'] }));
    expect(errors.some((e) => /mutually exclusive/.test(e))).toBe(true);
  });

  it('accepts a boolean sharedInput and rejects a non-boolean', () => {
    expect(validateMonitor(base({ sharedInput: true }))).toEqual([]);
    expect(validateMonitor(base({ sharedInput: false }))).toEqual([]);
    const errors = validateMonitor(base({ sharedInput: 'yes' as never }));
    expect(errors.some((e) => /sharedInput must be a boolean/.test(e))).toBe(true);
  });

  it('rejects a malformed rateLimit', () => {
    const errors = validateMonitor(base({ rateLimit: { max: 0, per: 'nope' } }));
    expect(errors.some((e) => /rateLimit\.max/.test(e))).toBe(true);
    expect(errors.some((e) => /rateLimit\.per/.test(e))).toBe(true);
  });

  it('accepts a run action with a postcondition command (PHNX-2842)', () => {
    expect(validateMonitor(base({
      action: {
        type: 'run',
        agent: 'claude',
        prompt: 'merge {event}',
        postcondition: 'gh pr view 1682 --json state --jq .state | grep -qx MERGED',
      },
    }))).toEqual([]);
  });

  it('rejects an empty postcondition', () => {
    const errors = validateMonitor(base({
      action: { type: 'run', agent: 'claude', prompt: 'x', postcondition: '  ' },
    }));
    expect(errors.some((e) => /action\.postcondition must be a non-empty shell command/.test(e))).toBe(true);
  });

  it('rejects a postcondition on notify (already has a synchronous ok)', () => {
    const errors = validateMonitor(base({
      action: { type: 'notify', notifyChannel: 'telegram', postcondition: 'true' },
    }));
    expect(errors.some((e) => /action\.postcondition only applies to run or routine/.test(e))).toBe(true);
  });
});

describe('parseInterval', () => {
  it('parses seconds', () => {
    expect(parseInterval('30s')).toBe(30_000);
  });
  it('parses compound durations', () => {
    expect(parseInterval('1h30m')).toBe((60 + 30) * 60 * 1000);
  });
  it('parses hours and days', () => {
    expect(parseInterval('8h')).toBe(8 * 60 * 60 * 1000);
    expect(parseInterval('1d')).toBe(24 * 60 * 60 * 1000);
  });
  it('rejects garbage and zero', () => {
    expect(parseInterval('nope')).toBeNull();
    expect(parseInterval('0s')).toBeNull();
    expect(parseInterval('')).toBeNull();
  });
});

describe('monitorRunsOnThisDevice — owner semantics', () => {
  it('runs anywhere when unrestricted', () => {
    expect(monitorRunsOnThisDevice({})).toBe(true);
  });
  it('runs only on the owner device', () => {
    expect(monitorRunsOnThisDevice({ device: machineId() })).toBe(true);
    expect(monitorRunsOnThisDevice({ device: 'some-other-box-xyz' })).toBe(false);
  });
  it('honors an allowlist', () => {
    expect(monitorRunsOnThisDevice({ devices: [machineId(), 'other'] })).toBe(true);
    expect(monitorRunsOnThisDevice({ devices: ['other-a', 'other-b'] })).toBe(false);
  });

  // SING-9: an unpinned shared-input built-in must NOT fire on every box (the 2026-08-03
  // double-fire class: every daemon races on a fleet-shared queue). `ownerHost` is passed
  // explicitly so placement is asserted without a live tailnet.
  const OTHER_BOX = 'some-other-box-xyz';

  it('an unpinned SYSTEM built-in does NOT fire on a non-owner box', () => {
    // pr-merge-on-green shape: system scope, no device pin, mode `every`.
    const builtin = { scope: 'system' as const };
    // Owner is another box → this daemon must stay inert (no double-fire).
    expect(monitorRunsOnThisDevice(builtin, OTHER_BOX)).toBe(false);
    // Explicitly-declared shared-input, same result.
    expect(monitorRunsOnThisDevice({ scope: 'system', sharedInput: true }, OTHER_BOX)).toBe(false);
  });

  it('an unpinned SYSTEM built-in fires only on the resolved owner box', () => {
    expect(monitorRunsOnThisDevice({ scope: 'system' }, machineId())).toBe(true);
  });

  it('an unpinned SYSTEM built-in fires NOWHERE when no owner resolves (fail safe)', () => {
    // Multi-box fleet, no interactive host pinned → no safe single owner. Firing
    // nowhere (a silent no-op) beats a fleet-wide double-fire.
    expect(monitorRunsOnThisDevice({ scope: 'system' }, '')).toBe(false);
  });

  it('a device-local built-in (sharedInput: false) still fires fleet-wide', () => {
    // Input is the firing box's own state — every daemon may fire it, so the
    // owner override never applies (ownerHost is irrelevant here).
    expect(monitorRunsOnThisDevice({ scope: 'system', sharedInput: false }, OTHER_BOX)).toBe(true);
  });

  it('a built-in with an explicit device pin ignores the shared-input owner rule', () => {
    expect(monitorRunsOnThisDevice({ scope: 'system', device: machineId() }, OTHER_BOX)).toBe(true);
    expect(monitorRunsOnThisDevice({ scope: 'system', device: OTHER_BOX }, machineId())).toBe(false);
  });

  it('a USER monitor keeps its fleet-wide default; opts IN to owner-only with sharedInput', () => {
    // Unpinned user monitor unchanged — fires everywhere (the operator owns
    // single-executor discipline per SING-9).
    expect(monitorRunsOnThisDevice({ scope: 'user' }, OTHER_BOX)).toBe(true);
    expect(monitorRunsOnThisDevice({}, OTHER_BOX)).toBe(true);
    // Explicit opt-in makes a user monitor owner-restricted too.
    expect(monitorRunsOnThisDevice({ scope: 'user', sharedInput: true }, OTHER_BOX)).toBe(false);
  });

  it('requiresSingleOwner: default-safe for system, opt-in for user, pin wins', () => {
    expect(requiresSingleOwner({ scope: 'system' })).toBe(true);
    expect(requiresSingleOwner({ scope: 'system', sharedInput: false })).toBe(false);
    expect(requiresSingleOwner({ scope: 'user' })).toBe(false);
    expect(requiresSingleOwner({ scope: 'user', sharedInput: true })).toBe(true);
    // A pin is an explicit executor choice — never owner-overridden.
    expect(requiresSingleOwner({ scope: 'system', device: 'box' })).toBe(false);
    expect(requiresSingleOwner({ scope: 'system', devices: ['box'] })).toBe(false);
  });
});

describe('resolveSharedInputOwner — the single owner of an unpinned shared-input monitor', () => {
  it('prefers the configured interactive host', () => {
    expect(resolveSharedInputOwner('Yosemite-S0', ['zion', 'yosemite-s0'], 'zion')).toBe('yosemite-s0');
  });

  it('normalizes the interactive host (tailnet fqdn / case)', () => {
    expect(resolveSharedInputOwner('Yosemite-S0.tailnet.ts.net', [], 'zion')).toBe('yosemite-s0');
  });

  it('falls back to self on a single-box fleet (no peer, no race)', () => {
    expect(resolveSharedInputOwner(undefined, [], 'zion')).toBe('zion');
    expect(resolveSharedInputOwner(undefined, ['zion'], 'zion')).toBe('zion');
  });

  it('returns undefined on a multi-box fleet with no interactive host (fail safe)', () => {
    expect(resolveSharedInputOwner(undefined, ['zion', 'mark-1'], 'zion')).toBeUndefined();
  });
});

describe('monitor CRUD round-trip', () => {
  const name = `test-monitor-${process.pid}-${Date.now()}`;

  afterEach(() => {
    deleteMonitor(name);
  });

  it('writes, reads back, lists, and deletes a monitor', () => {
    const config = base({ name }) as MonitorConfig;
    writeMonitor(config);

    const read = readMonitor(name);
    expect(read).not.toBeNull();
    expect(read!.name).toBe(name);
    expect(read!.source.type).toBe('poll');
    expect(read!.condition.mode).toBe('on-change');
    expect(read!.action.type).toBe('notify');

    expect(listMonitors().some((m) => m.name === name)).toBe(true);

    expect(deleteMonitor(name)).toBe(true);
    expect(readMonitor(name)).toBeNull();
  });
});

describe('system-layer monitors (built-ins from ~/.agents/.system/monitors/)', () => {
  let userDir: string;
  let sysDir: string;
  const prevUser = process.env.AGENTS_MONITORS_DIR;
  const prevSys = process.env.AGENTS_SYSTEM_MONITORS_DIR;

  /** A full valid monitor YAML: a poll source, on-change condition and a notify action on the given
   * channel. `header` prepends name/enabled lines per test. */
  function monitorYaml(header: string, notifyChannel = 'telegram'): string {
    return (
      header +
      'source:\n' +
      '  type: poll\n' +
      '  command: echo hi\n' +
      '  interval: 30s\n' +
      'condition:\n' +
      '  mode: on-change\n' +
      'action:\n' +
      '  type: notify\n' +
      `  notifyChannel: ${notifyChannel}\n`
    );
  }

  beforeEach(() => {
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-user-'));
    sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-sys-'));
    process.env.AGENTS_MONITORS_DIR = userDir;
    process.env.AGENTS_SYSTEM_MONITORS_DIR = sysDir;
  });

  afterEach(() => {
    if (prevUser === undefined) delete process.env.AGENTS_MONITORS_DIR;
    else process.env.AGENTS_MONITORS_DIR = prevUser;
    if (prevSys === undefined) delete process.env.AGENTS_SYSTEM_MONITORS_DIR;
    else process.env.AGENTS_SYSTEM_MONITORS_DIR = prevSys;
    fs.rmSync(userDir, { recursive: true, force: true });
    fs.rmSync(sysDir, { recursive: true, force: true });
  });

  it('(a) discovers a monitor placed in the system dir', () => {
    fs.writeFileSync(path.join(sysDir, 'built-in.yml'), monitorYaml('name: built-in\nenabled: true\n'));
    const found = listMonitors().find((m) => m.name === 'built-in');
    expect(found).toBeDefined();
    expect(found!.enabled).toBe(true);
    expect(readMonitor('built-in')?.source.type).toBe('poll');
    // getMonitorPath is user-layer only (its caller writes), so a system-only
    // built-in returns null — `edit` materializes a user copy rather than
    // opening the pull-only mirror.
    expect(getMonitorPath('built-in')).toBeNull();
  });

  it('(b) a user monitor of the same name shadows the system one', () => {
    fs.writeFileSync(path.join(sysDir, 'dupe.yml'), monitorYaml('name: dupe\nenabled: true\n', 'telegram'));
    fs.writeFileSync(path.join(userDir, 'dupe.yml'), monitorYaml('name: dupe\nenabled: true\n', 'desktop'));

    // Exactly one entry for the name, and it is the user copy.
    const matches = listMonitors().filter((m) => m.name === 'dupe');
    expect(matches.length).toBe(1);
    expect(matches[0].action.notifyChannel).toBe('desktop');
    expect(readMonitor('dupe')?.action.notifyChannel).toBe('desktop');
    // getMonitorPath returns the user copy, not the system one.
    expect(getMonitorPath('dupe')).toBe(path.join(userDir, 'dupe.yml'));
  });

  it('(c) a system built-in with no enabled: field is ENABLED by default (PHNX-2506)', () => {
    // The bug: monitors were the lone system-layer resource that shipped
    // disabled+invisible. A built-in must now be on by default like rules,
    // hooks, commands, and skills — visible and firing on every install.
    fs.writeFileSync(path.join(sysDir, 'builtin.yml'), monitorYaml('name: builtin\n'));

    expect(readMonitor('builtin')?.enabled).toBe(true);
    expect(listMonitors().find((m) => m.name === 'builtin')?.enabled).toBe(true);
    // It is tagged as coming from the system layer so `list`/`view` can mark it.
    expect(readMonitor('builtin')?.scope).toBe('system');

    // A user monitor with no enabled: field still defaults to enabled too, and is
    // tagged `user` — same enabled default, distinct scope.
    fs.writeFileSync(path.join(userDir, 'userdefault.yml'), monitorYaml('name: userdefault\n'));
    expect(readMonitor('userdefault')?.enabled).toBe(true);
    expect(readMonitor('userdefault')?.scope).toBe('user');

    // The healthy opt-OUT path: the user shadows a built-in with enabled: false.
    fs.writeFileSync(path.join(sysDir, 'off.yml'), monitorYaml('name: off\nenabled: false\n'));
    expect(readMonitor('off')?.enabled).toBe(false);
  });

  it('(d) pausing a system built-in writes into the USER dir, never the system dir', () => {
    // Built-ins ship on; the only toggle is pause/resume (there is no enable/disable
    // verb). Pausing must materialize a user copy — the system mirror is pull-only.
    fs.writeFileSync(path.join(sysDir, 'builtin.yml'), monitorYaml('name: builtin\n'));
    expect(readMonitor('builtin')?.enabled).toBe(true);

    setMonitorEnabled('builtin', false); // the `pause` write path

    // The user dir now holds the materialized copy; the system mirror is untouched.
    expect(fs.existsSync(path.join(userDir, 'builtin.yml'))).toBe(true);
    const sysBody = fs.readFileSync(path.join(sysDir, 'builtin.yml'), 'utf-8');
    expect(sysBody).not.toContain('enabled: false');
    // `scope` is a derived annotation — it must NOT persist into the written YAML,
    // or a materialized user copy would carry `scope: system`.
    expect(fs.readFileSync(path.join(userDir, 'builtin.yml'), 'utf-8')).not.toContain('scope:');
    // The user copy now wins and reads disabled, tagged as a user-layer monitor.
    expect(readMonitor('builtin')?.enabled).toBe(false);
    expect(readMonitor('builtin')?.scope).toBe('user');
    expect(getMonitorPath('builtin')).toBe(path.join(userDir, 'builtin.yml'));

    // Editing (write) also lands in the user dir only.
    const cfg = readMonitor('builtin')!;
    cfg.action = { type: 'notify', notifyChannel: 'desktop' };
    writeMonitor(cfg);
    expect(getMonitorsDir()).toBe(userDir);
    expect(getSystemMonitorsDir()).toBe(sysDir);
    expect(readMonitor('builtin')?.action.notifyChannel).toBe('desktop');
    // The system file's action was not rewritten.
    expect(fs.readFileSync(path.join(sysDir, 'builtin.yml'), 'utf-8')).toContain('notifyChannel: telegram');
  });
});
