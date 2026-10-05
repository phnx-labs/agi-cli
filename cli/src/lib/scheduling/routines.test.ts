import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

// Keep this legacy-definition suite independent of the developer machine's
// device manifest. Device activation itself has a dedicated adjacent suite.
vi.mock('./routine-activation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routine-activation.js')>();
  return {
    ...actual,
    enabledRoutineNames: () => null,
    routineEnabledOnThisDevice: () => null,
  };
});
import { routineOwnerDevice, hasAmbiguousDevicePin, validateJob, validateTrigger, normalizeTriggerEvent, writeJob, readJob, deleteJob, listJobs, jobRunsOnThisDevice, checkJobDeviceEligibility, getJobRunsDir, getRunDir, finalizeRunMeta, writeRunMeta, resolveJobPrompt, getLatestCompletedRun, routineStats, computeProjectGroup, computeProjectGroupKind, projectGroupKey, projectGroupTitle, normalizeProjects, serializeJob, type JobConfig, type RunMeta } from './routines.js';
import { getRoutinesDir, getSystemRoutinesDir, getRunsDir, ensureAgentsDir } from '../state.js';
import * as state from '../state.js';
import { ROUTINE_AGENT_IDS } from '../agents.js';

/** Minimal valid schedule-based job. */
function baseJob(partial: Partial<JobConfig> = {}): Partial<JobConfig> {
  return {
    name: 'j',
    agent: 'claude',
    prompt: 'do it',
    ...partial,
  };
}

describe('serializeJob — committed flow-sequence formatting (RUSH-2505)', () => {
  it('re-serializes an unchanged flow sequence without adding [ a, b ] padding', () => {
    // Committed routine YAML uses unpadded flow sequences. The yaml emitter
    // defaults to padded output, which would flip the tracked file to a no-op
    // diff and block ~/.agents pulls fleet-wide.
    const committed = 'name: j\nschedule: 0 9 * * *\nagent: claude\nprompt: hi\ndevices: [yosemite-s0, zion]\n';
    const output = { name: 'j', schedule: '0 9 * * *', agent: 'claude', prompt: 'hi', devices: ['yosemite-s0', 'zion'] };
    const out = serializeJob(output, committed);
    expect(out).toContain('devices: [yosemite-s0, zion]');
    expect(out).not.toMatch(/\[ /);
    expect(out).not.toMatch(/ \]/);
  });
});

describe('validateJob — schedule OR trigger', () => {
  it('accepts a schedule-only job (existing cron behavior unchanged)', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *' }))).toEqual([]);
  });

  it('accepts a trigger-only job (no schedule)', () => {
    const errors = validateJob(baseJob({ trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' } }));
    expect(errors).toEqual([]);
  });

  it('accepts a job with both schedule and trigger', () => {
    const errors = validateJob(baseJob({
      schedule: '0 3 * * *',
      trigger: { type: 'github_event', event: 'push' },
    }));
    expect(errors).toEqual([]);
  });

  it('rejects a job with neither schedule nor trigger', () => {
    const errors = validateJob(baseJob({}));
    expect(errors.some((e) => /schedule .* or trigger is required/.test(e))).toBe(true);
  });

  it('still rejects an invalid cron expression', () => {
    const errors = validateJob(baseJob({ schedule: 'not a cron' }));
    expect(errors.some((e) => /invalid cron expression/.test(e))).toBe(true);
  });

  it('surfaces trigger validation errors', () => {
    const errors = validateJob(baseJob({ trigger: { type: 'github_event', event: 'nope' as never } }));
    expect(errors.some((e) => /trigger\.event must be one of/.test(e))).toBe(true);
  });
});

describe('validateJob — YAML null path diagnostics (PHNX-3943)', () => {
  it('explains that a bare cwd: ~ parses as YAML null and gives the quoted form', () => {
    const parsed = yaml.parse('cwd: ~\n') as { cwd: null };
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', cwd: parsed.cwd as unknown as string }));

    expect(errors).toContain('cwd is null — a bare ~ is YAML null; quote it as "~" for the home directory');
    expect(errors).not.toContain('cwd (the portable execution directory) must be a non-empty path string');
  });

  it('names a null project separately from an empty project name', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', project: null as unknown as string }));

    expect(errors).toContain('project is null — quote YAML values that look like null literals');
    expect(errors).not.toContain('project (the singular execution anchor) must be a non-empty project name');
  });
});

describe('validateJob — resume', () => {
  it('accepts resume with a native-resume agent', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', resume: 'sess-1' }))).toEqual([]);
    expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: 'codex', resume: 'sess-1' }))).toEqual([]);
  });

  it('rejects resume on an agent without native --resume', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'kimi', resume: 'sess-1' }));
    expect(errors.some((e) => /resume is only supported for agents with native --resume/.test(e))).toBe(true);
  });

  it('rejects resume combined with a workflow', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: undefined, workflow: 'autodev', resume: 'sess-1' }));
    expect(errors.some((e) => /resume cannot be combined with workflow/.test(e))).toBe(true);
  });

  it('rejects resume combined with a loop', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', resume: 'sess-1', loop: { maxIterations: 3 } as never }));
    expect(errors.some((e) => /resume cannot be combined with loop/.test(e))).toBe(true);
  });

  it('rejects an empty resume session id', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', resume: '  ' }));
    expect(errors.some((e) => /resume must be a non-empty session id/.test(e))).toBe(true);
  });
});

describe('validateJob — schedule-time agent validation (RUSH-2102)', () => {
  it('accepts a daemon-supported agent for a local (default placement) routine', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude' }))).toEqual([]);
  });

  it('rejects a real agent the local daemon cannot fire, at add time', () => {
    // opencode is installable (ALL_AGENT_IDS) but absent from ROUTINE_AGENT_IDS/AGENT_COMMANDS, so
    // the daemon can't build its command. validateJob used to let it through to fail at fire time
    // ("Unsupported agent for daemon jobs").
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'opencode' }));
    expect(errors.some((e) => e.includes("agent 'opencode' is not supported by the local routine daemon"))).toBe(true);
    expect(errors.some((e) => e.includes(ROUTINE_AGENT_IDS.join(', ')))).toBe(true);
  });

  it('still rejects a completely unknown agent name with the existing ALL_AGENT_IDS message', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'not-a-real-agent' }));
    expect(errors.some((e) => e.startsWith('agent must be one of:'))).toBe(true);
    expect(errors.some((e) => e.includes('not supported by the local routine daemon'))).toBe(false);
  });

  it('accepts a custom harness (profile) name for a local routine (RUSH-2930)', () => {
    // A custom harness like `deepseek` is delegated to `agents run <name>` by
    // the runner (the workflow-job path), so it needs neither ALL_AGENT_IDS
    // membership nor a ROUTINE_AGENT_COMMANDS template.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-harness-'));
    fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'profiles', 'deepseek.yml'),
      yaml.stringify({ name: 'deepseek', host: { agent: 'claude' }, env: { ANTHROPIC_MODEL: 'deepseek/deepseek-chat-v3-0324' } }),
    );
    const spy = vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(dir);
    try {
      expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: 'deepseek' }))).toEqual([]);
      // Still rejects a name that is neither native nor an existing profile.
      const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'no-such-harness' }));
      expect(errors.some((e) => e.startsWith('agent must be one of:'))).toBe(true);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not restrict a real agent outside ROUTINE_AGENT_IDS when explicitly host-placed', () => {
    // hostStrategy: host dispatches via `agents run <agent>` on the remote
    // machine (hosts/run-target.ts), never through the daemon's AGENT_COMMANDS
    // table, so opencode is legitimate there — this must not regress.
    const errors = validateJob(baseJob({
      schedule: '0 3 * * *', agent: 'opencode', host: 'gpu-box', devices: ['zion'],
    }));
    expect(errors).toEqual([]);
  });

  it('does not restrict a real agent outside ROUTINE_AGENT_IDS under hostStrategy: fleet', () => {
    const errors = validateJob(baseJob({
      schedule: '0 3 * * *', agent: 'opencode', hostStrategy: 'fleet', devices: ['zion'],
    }));
    expect(errors).toEqual([]);
  });

  it('does not restrict a real agent outside ROUTINE_AGENT_IDS under hostStrategy: cloud', () => {
    const errors = validateJob(baseJob({
      schedule: '0 3 * * *', agent: 'opencode', hostStrategy: 'cloud', devices: ['zion'],
    }));
    expect(errors).toEqual([]);
  });
});

describe('validateJob — command', () => {
  it('accepts a command-only job (no agent, no prompt)', () => {
    expect(
      validateJob({ name: 'j', schedule: '0 3 * * *', command: 'echo hi' } as Partial<JobConfig>),
    ).toEqual([]);
  });

  it('rejects a job with both agent and command', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', command: 'echo hi' }));
    expect(errors.some((e) => /exactly one of agent, workflow, or command may be set/.test(e))).toBe(true);
  });

  it('rejects a job with both workflow and command', () => {
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *', workflow: 'autodev', command: 'echo hi' } as Partial<JobConfig>);
    expect(errors.some((e) => /exactly one of agent, workflow, or command may be set/.test(e))).toBe(true);
  });

  it('rejects a whitespace-only command string', () => {
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *', command: '   ' } as Partial<JobConfig>);
    expect(errors.some((e) => /command must be a non-empty shell command string/.test(e))).toBe(true);
  });

  it('rejects an empty-string command as a missing target', () => {
    // '' is falsy, so hasCommand is false → the "exactly one required" guard fires.
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *', command: '' } as Partial<JobConfig>);
    expect(errors.some((e) => /exactly one of agent, workflow, or command is required/.test(e))).toBe(true);
  });

  it('rejects a job with none of agent, workflow, or command', () => {
    const errors = validateJob({ name: 'j', schedule: '0 3 * * *' } as Partial<JobConfig>);
    expect(errors.some((e) => /exactly one of agent, workflow, or command is required/.test(e))).toBe(true);
  });
});

describe('validateTrigger', () => {
  it('accepts a well-formed github_event trigger', () => {
    expect(validateTrigger({
      type: 'github_event',
      event: 'pull_request',
      repo: 'x/y',
      branch: 'main',
      action: 'labeled',
      label: 'ux-approved',
    })).toEqual([]);
  });

  it('accepts a well-formed linear_event trigger', () => {
    expect(validateTrigger({ type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' })).toEqual([]);
  });

  it('accepts stateTo and stateFrom on linear_event triggers', () => {
    expect(validateTrigger({
      type: 'linear_event',
      event: 'Issue',
      action: 'update',
      stateTo: 'Plan',
      stateFrom: 'Triage',
    })).toEqual([]);
  });

  it('rejects non-string stateTo/stateFrom on linear_event triggers', () => {
    expect(validateTrigger({ type: 'linear_event', event: 'Issue', stateTo: 123 as never })).toContain('trigger.stateTo must be a string');
    expect(validateTrigger({ type: 'linear_event', event: 'Issue', stateFrom: 123 as never })).toContain('trigger.stateFrom must be a string');
  });

  it('rejects a bad type', () => {
    expect(validateTrigger({ type: 'gitlab', event: 'pull_request' })).toContain("trigger.type must be 'github_event' or 'linear_event'");
  });

  it('rejects an unknown event', () => {
    const errors = validateTrigger({ type: 'github_event', event: 'deploy' });
    expect(errors.some((e) => /trigger\.event must be one of/.test(e))).toBe(true);
  });

  it('rejects a malformed repo', () => {
    const errors = validateTrigger({ type: 'github_event', event: 'push', repo: 'not-a-repo' });
    expect(errors).toContain('trigger.repo must be in owner/name form');
  });
});

describe('default execution mode (RUSH-1595: plan -> auto)', () => {
  it('a routine YAML with no explicit mode defaults to auto', () => {
    ensureAgentsDir();
    const name = '__test-default-mode-rush1595__';
    const file = path.join(getRoutinesDir(), name + '.yml');
    try {
      // Write a raw config that omits `mode` entirely, exercising JOB_DEFAULTS.
      fs.writeFileSync(file, `name: ${name}\nschedule: '0 3 * * *'\nagent: claude\nprompt: do it\n`, 'utf-8');
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.mode).toBe('auto');
    } finally {
      deleteJob(name);
    }
  });

  it('writeJob omits mode when it equals the auto default, but persists a non-default plan', () => {
    ensureAgentsDir();
    const name = '__test-mode-serialize-rush1595__';
    const file = path.join(getRoutinesDir(), name + '.yml');
    const base: JobConfig = {
      name,
      schedule: '0 3 * * *',
      agent: 'claude',
      prompt: 'do it',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
    try {
      writeJob({ ...base, mode: 'auto' });
      expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/^mode:/m);

      writeJob({ ...base, mode: 'plan' });
      expect(fs.readFileSync(file, 'utf-8')).toMatch(/^mode:\s*plan/m);
    } finally {
      deleteJob(name);
    }
  });
});

describe('system-layer routines (built-ins from ~/.agents/.system/routines/)', () => {
  const sysDir = getSystemRoutinesDir();

  it('listJobs surfaces a system routine, and a user routine of the same name shadows it', () => {
    ensureAgentsDir();
    const name = '__test-system-routine-union__';
    const sysFile = path.join(sysDir, `${name}.yml`);
    fs.mkdirSync(sysDir, { recursive: true });
    try {
      // A built-in shipped via the system repo — enabled, on a schedule.
      fs.writeFileSync(
        sysFile,
        `name: ${name}\nschedule: '0 9 * * 1'\nenabled: true\nagent: claude\nprompt: check for updates\n`,
        'utf-8'
      );

      // Daemon-style call (no cwd) must see the system routine.
      let found = listJobs().find((j) => j.name === name);
      expect(found).toBeDefined();
      expect(found!.enabled).toBe(true);
      expect(readJob(name)?.prompt).toBe('check for updates');

      // A user routine of the same name overrides it (here: disables the built-in).
      writeJob({
        name,
        schedule: '0 9 * * 1',
        agent: 'claude',
        prompt: 'overridden',
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: false,
      } as JobConfig);

      found = listJobs().find((j) => j.name === name);
      expect(found).toBeDefined();
      expect(found!.enabled).toBe(false);          // a new definition is inactive until device activation
      expect(fs.readFileSync(path.join(getRoutinesDir(), `${name}.yml`), 'utf-8')).not.toContain('enabled:');
      expect(found!.prompt).toBe('overridden');
      // Only one entry for the name — user shadows system, no duplicate.
      expect(listJobs().filter((j) => j.name === name).length).toBe(1);
    } finally {
      deleteJob(name);                              // removes the user override
      try { fs.unlinkSync(sysFile); } catch { /* already gone */ }
    }
  });
});

describe('writeJob atomic persistence', () => {
  it('round-trips a job through an atomic write and leaves no temp files', () => {
    ensureAgentsDir();
    const name = '__test-atomic-write-routine__';
    const routinesDir = getRoutinesDir();
    const file = path.join(routinesDir, `${name}.yml`);
    const config: JobConfig = {
      name,
      schedule: '0 3 * * *',
      agent: 'claude',
      prompt: 'round-trip check',
      mode: 'plan',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
    try {
      writeJob(config);
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.name).toBe(name);
      expect(read!.agent).toBe('claude');
      expect(read!.schedule).toBe('0 3 * * *');
      expect(read!.prompt).toBe('round-trip check');

      const leftovers = fs.readdirSync(routinesDir).filter((f) => f.startsWith(`${name}.yml.tmp-`));
      expect(leftovers).toEqual([]);
    } finally {
      deleteJob(name);
    }
  });

  it('stamps the creator actor at creation and preserves it across an edit (RUSH-2020)', () => {
    ensureAgentsDir();
    const name = '__test-actor-stamp-routine__';
    const name2 = '__test-actor-pinned-routine__';
    try {
      writeJob({ name, schedule: '0 3 * * *', agent: 'claude', prompt: 'p' } as JobConfig);
      const created = readJob(name);
      // A fresh routine gets the current resolver stamped (non-empty id).
      expect(created?.actor).toBeTruthy();
      // An edit re-writes the loaded config (which already carries actor) — the
      // original creator is preserved, not overwritten with the editor.
      writeJob({ ...created!, prompt: 'edited' } as JobConfig);
      const after = readJob(name);
      expect(after?.prompt).toBe('edited');
      expect(after?.actor).toBe(created?.actor);
      // An explicit actor on a new config is kept as-is.
      writeJob({ name: name2, schedule: '0 3 * * *', agent: 'claude', prompt: 'p', actor: 'pinned@example.com' } as JobConfig);
      expect(readJob(name2)?.actor).toBe('pinned@example.com');
    } finally {
      deleteJob(name);
      deleteJob(name2);
    }
  });
});

describe('normalizeTriggerEvent', () => {
  it('maps canonical names and aliases', () => {
    expect(normalizeTriggerEvent('pull_request')).toBe('pull_request');
    expect(normalizeTriggerEvent('pr')).toBe('pull_request');
    expect(normalizeTriggerEvent('pr_opened')).toBe('pull_request');
    expect(normalizeTriggerEvent('PUSH')).toBe('push');
    expect(normalizeTriggerEvent('comment')).toBe('issue_comment');
    expect(normalizeTriggerEvent('workflow')).toBe('workflow_run');
  });

  it('returns null for unknown events', () => {
    expect(normalizeTriggerEvent('deploy')).toBeNull();
  });
});

describe('validateJob — devices', () => {
  it('accepts a job with a devices allowlist', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', devices: ['yosemite-s0'] }))).toEqual([]);
  });

  // Was 'accepts a job with multiple devices'. A multi-device pin fired the
  // routine once per listed device — duplicate agent runs on every schedule —
  // so it is now a validation error, not an accepted config.
  it('rejects a job with multiple devices', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', devices: ['yosemite-s0', 'mac-mini'] }));
    expect(errors.some((e) => e.includes('runs on exactly one'))).toBe(true);
  });

  it('accepts a job pinned to a single device', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', devices: ['yosemite-s0'] }))).toEqual([]);
  });

  it('rejects a non-array devices', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', devices: 'yosemite-s0' as never }));
    expect(errors.some((e) => /devices must be an array/.test(e))).toBe(true);
  });

  it('rejects an empty-string entry', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', devices: [''] }));
    expect(errors.some((e) => /each entry in devices/.test(e))).toBe(true);
  });

  it('rejects a stale singular "device" key after v12', () => {
    const config = { ...baseJob({ schedule: '0 3 * * *' }), device: 'yosemite-s0' } as Record<string, unknown>;
    const errors = validateJob(config as Partial<JobConfig>);
    expect(errors.some((e) => /singular "device" key is no longer supported/.test(e) && /devices:/.test(e))).toBe(true);
  });
});

// A routine pinned to several devices used to fire once PER device (`security-sweep` ran at
// 15:30:02 on one box and 15:30:03 on another, two sessions doing identical work). Ownership is now
// singular and derived from config alone, so every daemon agrees without coordination.
describe('routineOwnerDevice / single-device ownership', () => {
  it('picks one owner deterministically, whatever the list order', () => {
    expect(routineOwnerDevice({ devices: ['yosemite-s1', 'yosemite-s0'] })).toBe('yosemite-s0');
    expect(routineOwnerDevice({ devices: ['yosemite-s0', 'yosemite-s1'] })).toBe('yosemite-s0');
    expect(routineOwnerDevice({ devices: ['Yosemite-S1', 'yosemite-s0.tailnet.ts.net'] })).toBe('yosemite-s0');
  });

  it('returns null for an unrestricted routine, which still fires fleet-wide', () => {
    expect(routineOwnerDevice({})).toBeNull();
    expect(routineOwnerDevice({ devices: [] })).toBeNull();
  });

  it('fires on exactly one of a multi-device pin — never both', () => {
    const pinned = { devices: ['yosemite-s0', 'yosemite-s1'] };
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice(pinned)).toBe(true);
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s1';
    expect(jobRunsOnThisDevice(pinned)).toBe(false);
  });

  it('flags a multi-device pin, ignoring case and domain duplicates', () => {
    expect(hasAmbiguousDevicePin({ devices: ['yosemite-s0', 'yosemite-s1'] })).toBe(true);
    expect(hasAmbiguousDevicePin({ devices: ['yosemite-s0'] })).toBe(false);
    expect(hasAmbiguousDevicePin({ devices: [] })).toBe(false);
    // Same machine spelled two ways is one device, not an ambiguous pin.
    expect(hasAmbiguousDevicePin({ devices: ['Yosemite-S0', 'yosemite-s0.tailnet.ts.net'] })).toBe(false);
  });

  // The daemon's load path never calls validateJob and ownership treats a non-array `devices` as
  // "no pin", so a YAML typo (`devices: yosemite-s0`, a scalar) would silently promote the routine
  // to fleet-wide and fire it on EVERY box. Inert-and-loud beats unrestricted.
  it('refuses to load a routine whose devices is not a list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-malformed-'));
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      process.env.AGENTS_ROUTINES_DIR = path.join(dir, 'routines');
      fs.mkdirSync(path.join(dir, 'routines'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'routines', 'typo.yml'),
        'name: typo\nschedule: "0 3 * * *"\nagent: claude\nprompt: noop\ndevices: yosemite-s0\n',
      );
      expect(readJob('typo')).toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      delete process.env.AGENTS_ROUTINES_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to create a new multi-device routine', () => {
    const errors = validateJob({
      name: 'two-boxes', schedule: '0 3 * * *', agent: 'claude',
      mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'noop',
      devices: ['yosemite-s0', 'yosemite-s1'],
    });
    expect(errors.some((e) => e.includes('runs on exactly one'))).toBe(true);
  });
});

describe('jobRunsOnThisDevice', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('unrestricted jobs run everywhere', () => {
    expect(jobRunsOnThisDevice({})).toBe(true);
    expect(jobRunsOnThisDevice({ devices: undefined })).toBe(true);
    expect(jobRunsOnThisDevice({ devices: [] })).toBe(true);
  });

  it('matches when the allowlist includes this machine', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0'] })).toBe(true);
    // A multi-device pin no longer matches every listed device — only its owner
    // (lowest normalized name) fires, so the routine runs once, not once per box.
    expect(jobRunsOnThisDevice({ devices: ['mac-mini', 'yosemite-s0'] })).toBe(false);
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0', 'zion'] })).toBe(true);
  });

  it('normalizes case and domain suffix', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    expect(jobRunsOnThisDevice({ devices: ['Yosemite-S0'] })).toBe(true);
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0.tailnet.ts.net'] })).toBe(true);
  });

  it('rejects when allowlist names other machines', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0'] })).toBe(false);
    expect(jobRunsOnThisDevice({ devices: ['yosemite-s0', 'mac-mini'] })).toBe(false);
  });
});

describe('checkJobDeviceEligibility', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('returns null for unrestricted jobs', () => {
    expect(checkJobDeviceEligibility({ name: 'j' })).toBeNull();
    expect(checkJobDeviceEligibility({ name: 'j', devices: [] })).toBeNull();
  });

  it('returns null when this machine is in the allowlist', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    expect(checkJobDeviceEligibility({ name: 'j', devices: ['zion'] })).toBeNull();
  });

  it('returns normalized message, suggestion, and allowed label for foreign jobs', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const result = checkJobDeviceEligibility({ name: 'backup', devices: ['Yosemite-S0.tailnet.ts.net', 'mac-mini'] });
    expect(result).not.toBeNull();
    expect(result!.message).toBe("Job 'backup' can only run on: yosemite-s0, mac-mini");
    expect(result!.allowedLabel).toBe('yosemite-s0, mac-mini');
    // The suggested host is the OWNER (lowest normalized name), not the first
    // entry as written. Suggesting yosemite-s0 here would send the operator to
    // a box that refuses the run for exactly the same reason.
    expect(result!.firstHost).toBe('mac-mini');
    expect(result!.suggestion).toBe("agents routines run backup --device mac-mini");
  });
});

describe('readJobFile fails closed on legacy singular device key', () => {
  it('returns null for a YAML file that still contains device:', () => {
    ensureAgentsDir();
    const name = '__test-readjob-device__';
    const file = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      fs.writeFileSync(file, yaml.stringify({
        name, schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'yosemite-s0',
      }));
      expect(readJob(name)).toBeNull();
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });
});

/** `dispatchedBy: 'monitor'` makes jobRunsOnThisDevice skip the device activation manifest
 * (RUSH-2681), right for a monitor's synthesized job. A routine YAML carrying it would fire on
 * every box regardless of activation, since the daemon's load path never calls validateJob. */
describe('readJobFile fails closed on the runtime-only dispatchedBy marker', () => {
  it('returns null for a YAML file that contains dispatchedBy:', () => {
    ensureAgentsDir();
    const name = '__test-readjob-dispatchedby__';
    const file = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      fs.writeFileSync(file, yaml.stringify({
        name, schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', dispatchedBy: 'monitor',
      }));
      expect(readJob(name)).toBeNull();
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  it('writeJob never persists the marker, so a round-trip cannot smuggle it in', () => {
    ensureAgentsDir();
    const name = '__test-writejob-dispatchedby__';
    const file = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      writeJob({
        name, schedule: '0 3 * * *', agent: 'claude', prompt: 'hi',
        mode: 'auto', effort: 'auto', timeout: '10m', enabled: true,
        dispatchedBy: 'monitor',
      } as JobConfig);
      expect(fs.readFileSync(file, 'utf-8')).not.toContain('dispatchedBy');
      // Still readable — the marker was dropped, not turned into an inert file.
      expect(readJob(name)?.prompt).toBe('hi');
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });
});

describe('writeJob extension handling', () => {
  function fullConfig(name: string): JobConfig {
    return {
      name,
      schedule: '0 3 * * *',
      agent: 'claude',
      prompt: 'extension test',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;
  }

  it('updates an existing .yaml file and does not create a .yml sibling', () => {
    ensureAgentsDir();
    const name = '__test-writejob-yaml__';
    const yamlFile = path.join(getRoutinesDir(), `${name}.yaml`);
    const ymlFile = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      fs.writeFileSync(yamlFile, yaml.stringify({
        name, schedule: '0 4 * * *', agent: 'codex', prompt: 'original',
      }));
      writeJob(fullConfig(name));
      expect(fs.existsSync(yamlFile)).toBe(true);
      expect(fs.existsSync(ymlFile)).toBe(false);
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.agent).toBe('claude');
    } finally {
      if (fs.existsSync(yamlFile)) fs.unlinkSync(yamlFile);
      if (fs.existsSync(ymlFile)) fs.unlinkSync(ymlFile);
    }
  });

  it('creates a new routine as .yml when neither extension exists', () => {
    ensureAgentsDir();
    const name = '__test-writejob-new__';
    const yamlFile = path.join(getRoutinesDir(), `${name}.yaml`);
    const ymlFile = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      writeJob(fullConfig(name));
      expect(fs.existsSync(ymlFile)).toBe(true);
      expect(fs.existsSync(yamlFile)).toBe(false);
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.name).toBe(name);
    } finally {
      if (fs.existsSync(yamlFile)) fs.unlinkSync(yamlFile);
      if (fs.existsSync(ymlFile)) fs.unlinkSync(ymlFile);
    }
  });

  it('throws when both .yml and .yaml files exist for the same name', () => {
    ensureAgentsDir();
    const name = '__test-writejob-both__';
    const ymlFile = path.join(getRoutinesDir(), `${name}.yml`);
    const yamlFile = path.join(getRoutinesDir(), `${name}.yaml`);
    try {
      fs.writeFileSync(ymlFile, yaml.stringify({ name, schedule: '0 3 * * *', agent: 'claude', prompt: 'a' }));
      fs.writeFileSync(yamlFile, yaml.stringify({ name, schedule: '0 4 * * *', agent: 'codex', prompt: 'b' }));
      expect(() => writeJob(fullConfig(name))).toThrow(/both \.yml and \.yaml/);
    } finally {
      if (fs.existsSync(ymlFile)) fs.unlinkSync(ymlFile);
      if (fs.existsSync(yamlFile)) fs.unlinkSync(yamlFile);
    }
  });
});

describe('validateJob — host placement', () => {
  it('accepts a plain host-placed agent job with a devices pin', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', host: 'gpu-box', devices: ['zion'] }))).toEqual([]);
  });

  it('accepts host placement without definition-level device state', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', host: 'gpu-box' }));
    expect(errors).toEqual([]);
  });

  it('rejects an empty host', () => {
    expect(validateJob(baseJob({ host: '  ', devices: ['zion'] }))).toContainEqual(expect.stringContaining('host must be a non-empty machine name'));
  });

  it('rejects host + workflow (bundle lives on the firing machine)', () => {
    const errors = validateJob(baseJob({ host: 'gpu-box', devices: ['zion'], workflow: 'autodev', agent: undefined }));
    expect(errors.some((e) => e.includes('host placement') && e.includes('workflow'))).toBe(true);
  });

  it('rejects host + loop (driver + signal files live on the firing machine)', () => {
    const errors = validateJob(baseJob({ host: 'gpu-box', devices: ['zion'], loop: { maxIterations: 2 } as JobConfig['loop'] }));
    expect(errors.some((e) => e.includes('host placement') && e.includes('loop'))).toBe(true);
  });

  it('rejects host + command (shell command has no agent to place remotely)', () => {
    const errors = validateJob({ name: 'cmd-on-host', schedule: '0 3 * * *', command: 'echo hi', host: 'gpu-box', devices: ['zion'], mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: '' } as JobConfig);
    expect(errors.some((e) => e.includes('host placement') && e.includes('command'))).toBe(true);
  });

  it('rejects remoteCwd without host/fleet placement', () => {
    expect(validateJob(baseJob({ remoteCwd: '~/proj' }))).toContainEqual(expect.stringContaining('remoteCwd only applies'));
  });
});

describe('routine name path containment (C4)', () => {
  const runsDir = path.resolve(getRunsDir());

  it('validateJob rejects a traversal name', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', name: '../../../../etc' })))
      .toContain(
        `invalid name "../../../../etc": must be a single path segment ` +
        `(no '/', '\\\\', or null bytes, and not '.' or '..')`,
      );
  });

  it('validateJob rejects a name with a separator', () => {
    const errs = validateJob(baseJob({ schedule: '0 3 * * *', name: 'a/b' }));
    expect(errs.some(e => e.startsWith('invalid name'))).toBe(true);
  });

  it('validateJob accepts a normal single-segment name', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', name: 'daily-standup' }))).toEqual([]);
  });

  // getRunDir is the run-directory sink reached on the daemon's load/schedule
  // path (runner.ts executeJob/executeJobDetached) — which never calls
  // validateJob — so it must contain the untrusted name itself.
  it('getJobRunsDir / getRunDir contain a benign name under the runs dir', () => {
    const p = getRunDir('daily-standup', 'run-1');
    expect(p).toBe(path.join(runsDir, 'daily-standup', 'run-1'));
    expect(path.resolve(p).startsWith(runsDir + path.sep)).toBe(true);
  });

  it('getRunDir rejects a traversal name so mkdirSync/writes cannot escape the runs dir', () => {
    expect(() => getRunDir('../../../../tmp/evil-routine', 'run-1')).toThrow();
    expect(() => getJobRunsDir('..')).toThrow();
    expect(() => getJobRunsDir('a/b')).toThrow();
  });
});

describe('finalizeRunMeta', () => {
  function makeMeta(startedAt: string): RunMeta {
    return {
      jobName: 'j',
      runId: 'r1',
      agent: 'claude',
      pid: null,
      status: 'running',
      startedAt,
      completedAt: null,
      exitCode: null,
    };
  }

  it('sets completedAt, exitCode, status, and computes duration from startedAt', () => {
    const startedAt = new Date(Date.now() - 1234).toISOString();
    const meta = makeMeta(startedAt);
    finalizeRunMeta(meta, 'completed', 0);
    expect(meta.status).toBe('completed');
    expect(meta.exitCode).toBe(0);
    expect(meta.completedAt).not.toBeNull();
    expect(meta.duration).toBeGreaterThanOrEqual(1234);
    expect(meta.errorMessage).toBeUndefined();
  });

  it('records errorMessage on failure when provided', () => {
    const meta = makeMeta(new Date().toISOString());
    finalizeRunMeta(meta, 'failed', 1, { errorMessage: 'spawn failed' });
    expect(meta.status).toBe('failed');
    expect(meta.exitCode).toBe(1);
    expect(meta.errorMessage).toBe('spawn failed');
    expect(meta.duration).toBeGreaterThanOrEqual(0);
  });

  it('uses a provided completedAt override and computes duration from it', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const completedAt = new Date('2026-01-01T00:00:05.000Z').toISOString();
    const meta = makeMeta(startedAt);
    finalizeRunMeta(meta, 'completed', 0, { completedAt });
    expect(meta.completedAt).toBe(completedAt);
    expect(meta.duration).toBe(5000);
  });

  it('clears a stale errorMessage when finalizing successfully', () => {
    const meta = makeMeta(new Date().toISOString());
    meta.errorMessage = 'stale';
    finalizeRunMeta(meta, 'completed', 0);
    expect(meta.errorMessage).toBeUndefined();
  });

  it('falls back to zero duration when startedAt is unparseable', () => {
    const meta = makeMeta('not-a-date');
    finalizeRunMeta(meta, 'failed', 1);
    expect(meta.duration).toBe(0);
  });
});

describe('getLatestCompletedRun / {last_report} poison-stop', () => {
  // Unique job name under the real runs dir; cleaned up after each test. runIds
  // are chosen so the FAILED run sorts LAST (most recent) — the exact shape that
  // used to poison the next prompt.
  const jobName = `__authtest_poison_${process.pid}`;

  function seedRun(runId: string, status: RunMeta['status'], report: string): void {
    const meta: RunMeta = {
      jobName,
      runId,
      agent: 'claude',
      pid: null,
      status,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: status === 'completed' ? 0 : 1,
      ...(status !== 'completed' ? { errorMessage: 'auth_failed: Failed to authenticate' } : {}),
    };
    writeRunMeta(meta);
    fs.writeFileSync(path.join(getRunDir(jobName, runId), 'report.md'), report, 'utf-8');
  }

  afterEach(() => {
    fs.rmSync(getJobRunsDir(jobName), { recursive: true, force: true });
  });

  it('returns the latest COMPLETED run, skipping a later failed run', () => {
    seedRun('2026-01-01T00-00-00-000Z', 'completed', 'GOOD REPORT');
    seedRun('2026-01-02T00-00-00-000Z', 'failed', 'Not logged in · Please run /login');

    const latest = getLatestCompletedRun(jobName);
    expect(latest?.runId).toBe('2026-01-01T00-00-00-000Z');
  });

  it('returns null when no run has completed', () => {
    seedRun('2026-01-01T00-00-00-000Z', 'failed', 'Failed to authenticate');
    expect(getLatestCompletedRun(jobName)).toBeNull();
  });

  it('{last_report} injects the completed report, never the failed auth text', () => {
    seedRun('2026-01-01T00-00-00-000Z', 'completed', 'GOOD REPORT');
    seedRun('2026-01-02T00-00-00-000Z', 'failed', 'Not logged in · Please run /login');

    const config = {
      name: jobName,
      agent: 'claude',
      schedule: '0 3 * * *',
      prompt: 'Previous: {last_report}',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;

    const resolved = resolveJobPrompt(config);
    expect(resolved).toContain('GOOD REPORT');
    expect(resolved).not.toContain('Not logged in');
    expect(resolved).not.toContain('/login');
  });

  it('substitutes {{...}} webhook context placeholders when context is passed', () => {
    const config = {
      name: jobName,
      agent: 'claude',
      schedule: '0 3 * * *',
      prompt: 'Issue {{issue.identifier}}: {{issue.title}} (from {{updatedFrom.state.name}})',
      mode: 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
    } as JobConfig;

    const resolved = resolveJobPrompt(config, {
      source: 'linear',
      event: 'Issue',
      action: 'update',
      issue: { identifier: 'RUSH-42', title: 'Fix it', state: { name: 'Plan' } },
      updatedFrom: { state: { name: 'Triage' } },
    });
    expect(resolved).toBe('Issue RUSH-42: Fix it (from Triage)');
  });
});

describe('routineStats', () => {
  const jobName = `__stats_test_${process.pid}`;

  function seedRun(runId: string, status: RunMeta['status'], duration?: number): void {
    const meta: RunMeta = {
      jobName,
      runId,
      agent: 'claude',
      pid: null,
      status,
      startedAt: new Date().toISOString(),
      completedAt: status === 'missed' ? null : new Date().toISOString(),
      exitCode: status === 'completed' ? 0 : status === 'missed' ? null : 1,
      ...(duration !== undefined ? { duration } : {}),
    };
    writeRunMeta(meta);
  }

  afterEach(() => {
    fs.rmSync(getJobRunsDir(jobName), { recursive: true, force: true });
  });

  it('returns all-zero stats for a job with no runs', () => {
    expect(routineStats(jobName)).toEqual({ count: 0, failed: 0, missed: 0, avgMs: 0, p50: 0, p95: 0 });
  });

  it('counts failed and missed runs separately from count, and folds duration into avg/p50/p95', () => {
    seedRun('r1', 'completed', 10);
    seedRun('r2', 'completed', 20);
    seedRun('r3', 'completed', 30);
    seedRun('r4', 'failed', 40);
    seedRun('r5', 'timeout', 50);
    seedRun('r6', 'missed'); // no duration — a fire that never ran

    const stats = routineStats(jobName);
    expect(stats.count).toBe(6);
    expect(stats.failed).toBe(2); // failed + timeout
    expect(stats.missed).toBe(1);
    // avg of the 5 durations that have one (10+20+30+40+50)/5 = 30
    expect(stats.avgMs).toBe(30);
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
  });

  it('excludes the missed run (no duration) from the percentile set entirely', () => {
    seedRun('r1', 'completed', 100);
    seedRun('r2', 'missed');

    const stats = routineStats(jobName);
    expect(stats.count).toBe(2);
    expect(stats.missed).toBe(1);
    // Only one real duration sample (100ms) — p50/p95 both collapse to it,
    // not diluted by the missed run's absent duration.
    expect(stats.avgMs).toBe(100);
    expect(stats.p50).toBe(100);
    expect(stats.p95).toBe(100);
  });
});

describe('validateJob — projects field', () => {
  it('accepts a job with no projects (default: absent)', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *' }))).toEqual([]);
  });

  it('accepts a job with a single valid project name', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', projects: ['my-project'] }))).toEqual([]);
  });

  it('accepts a job with multiple valid project names', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', projects: ['project-a', 'project-b'] }))).toEqual([]);
  });

  it('accepts ["*"] as the all-projects sentinel', () => {
    expect(validateJob(baseJob({ schedule: '0 3 * * *', projects: ['*'] }))).toEqual([]);
  });

  it('rejects projects that is not an array', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', projects: 'my-project' as never }));
    expect(errors.some((e) => /projects must be an array/.test(e))).toBe(true);
  });

  it('rejects "*" mixed with other names', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', projects: ['*', 'my-project'] }));
    expect(errors.some((e) => /"\*".*must be the sole entry/.test(e))).toBe(true);
  });

  it('rejects an empty-string project name', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', projects: [''] }));
    expect(errors.some((e) => /each entry in projects must be a non-empty project name/.test(e))).toBe(true);
  });

  it('rejects a project name with illegal characters', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', projects: ['../../evil'] }));
    expect(errors.some((e) => /invalid project name/.test(e))).toBe(true);
  });
});

describe('validateJob — projects round-trip via writeJob/readJob', () => {
  it('persists and reads back a projects array', () => {
    ensureAgentsDir();
    const name = '__test-projects-field-roundtrip__';
    try {
      writeJob({
        name,
        schedule: '0 3 * * *',
        agent: 'claude',
        prompt: 'test',
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: true,
        projects: ['project-a', 'project-b'],
      } as JobConfig);
      const read = readJob(name);
      expect(read).not.toBeNull();
      expect(read!.projects).toEqual(['project-a', 'project-b']);
    } finally {
      deleteJob(name);
    }
  });

  it('persists ["*"] as-is', () => {
    ensureAgentsDir();
    const name = '__test-projects-all-roundtrip__';
    try {
      writeJob({
        name,
        schedule: '0 3 * * *',
        agent: 'claude',
        prompt: 'test',
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: true,
        projects: ['*'],
      } as JobConfig);
      const read = readJob(name);
      expect(read!.projects).toEqual(['*']);
    } finally {
      deleteJob(name);
    }
  });

  it('omits projects from YAML when empty array', () => {
    ensureAgentsDir();
    const name = '__test-projects-empty-omit__';
    const filePath = path.join(getRoutinesDir(), `${name}.yml`);
    try {
      writeJob({
        name,
        schedule: '0 3 * * *',
        agent: 'claude',
        prompt: 'test',
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: true,
        projects: [],
      } as JobConfig);
      expect(fs.readFileSync(filePath, 'utf-8')).not.toMatch(/^projects:/m);
    } finally {
      deleteJob(name);
    }
  });
});

describe('computeProjectGroup', () => {
  const known = new Set(['project-a', 'project-b', 'project-c']);

  it('returns "Operations" for undefined projects', () => {
    expect(computeProjectGroup(undefined, known)).toBe('Operations');
  });

  it('returns "Operations" for an empty projects array', () => {
    expect(computeProjectGroup([], known)).toBe('Operations');
  });

  it('returns "All projects" for ["*"]', () => {
    expect(computeProjectGroup(['*'], known)).toBe('All projects');
  });

  it('returns the project name for a single known project', () => {
    expect(computeProjectGroup(['project-a'], known)).toBe('project-a');
  });

  it('returns "Cross-project" for multiple known projects', () => {
    expect(computeProjectGroup(['project-a', 'project-b'], known)).toBe('Cross-project');
  });

  it('returns "Unknown projects" when any project name is not in the known set', () => {
    expect(computeProjectGroup(['stale-project'], known)).toBe('Unknown projects');
    expect(computeProjectGroup(['project-a', 'stale-project'], known)).toBe('Unknown projects');
  });
});

describe('computeProjectGroupKind — discriminated buckets never collide with special labels', () => {
  it('classifies a project literally named "Operations" as a named group, distinct from the no-project special', () => {
    const known = new Set(['Operations', 'other']);
    const named = computeProjectGroupKind(['Operations'], known);
    const special = computeProjectGroupKind(undefined, known);
    expect(named).toEqual({ kind: 'named', name: 'Operations' });
    expect(special).toEqual({ kind: 'operations' });
    // Same human title, but different discriminated keys — so they never merge.
    expect(projectGroupTitle(named)).toBe('Operations');
    expect(projectGroupTitle(special)).toBe('Operations');
    expect(projectGroupKey(named)).toBe('named:Operations');
    expect(projectGroupKey(special)).toBe('special:operations');
    expect(projectGroupKey(named)).not.toBe(projectGroupKey(special));
  });

  it('classifies a project literally named "Cross-project" as a named group, distinct from the multi-project span special', () => {
    const known = new Set(['Cross-project', 'a', 'b']);
    const named = computeProjectGroupKind(['Cross-project'], known);
    const special = computeProjectGroupKind(['a', 'b'], known);
    expect(named).toEqual({ kind: 'named', name: 'Cross-project' });
    expect(special).toEqual({ kind: 'cross' });
    expect(projectGroupTitle(named)).toBe('Cross-project');
    expect(projectGroupTitle(special)).toBe('Cross-project');
    expect(projectGroupKey(named)).toBe('named:Cross-project');
    expect(projectGroupKey(special)).toBe('special:cross');
    expect(projectGroupKey(named)).not.toBe(projectGroupKey(special));
  });

  it('collapses duplicate names before classifying, so [myapp, myapp] is a single named project, not Cross-project', () => {
    const known = new Set(['myapp']);
    expect(computeProjectGroupKind(['myapp', 'myapp'], known)).toEqual({ kind: 'named', name: 'myapp' });
    expect(computeProjectGroup(['myapp', 'myapp'], known)).toBe('myapp');
  });
});

describe('normalizeProjects — canonical dedup', () => {
  it('deduplicates while preserving first-seen order', () => {
    expect(normalizeProjects(['myapp', 'myapp'])).toEqual(['myapp']);
    expect(normalizeProjects(['b', 'a', 'b', 'a'])).toEqual(['b', 'a']);
  });

  it('drops empty/whitespace-only and non-string entries', () => {
    expect(normalizeProjects(['a', '', 'a'])).toEqual(['a']);
    expect(normalizeProjects([undefined as unknown as string, 'x'])).toEqual(['x']);
  });

  it('returns undefined when nothing survives', () => {
    expect(normalizeProjects(undefined)).toBeUndefined();
    expect(normalizeProjects([])).toBeUndefined();
    expect(normalizeProjects(['', ''])).toBeUndefined();
  });

  it('keeps the ["*"] all-projects sentinel and collapses a duplicated sentinel', () => {
    expect(normalizeProjects(['*'])).toEqual(['*']);
    expect(normalizeProjects(['*', '*'])).toEqual(['*']);
  });
});

describe('duplicate project names in a file-created YAML routine', () => {
  it('reads as a single named project and rewrites canonically (persistence is deduped)', () => {
    const name = 'dup-project-yaml-' + Math.random().toString(36).slice(2, 8);
    const file = path.join(getRoutinesDir(), name + '.yml');
    try {
      ensureAgentsDir();
      // Hand-authored YAML that never went through the add command: duplicate names.
      fs.writeFileSync(
        file,
        `name: ${name}\nschedule: '0 3 * * *'\nagent: claude\nprompt: do it\nprojects:\n  - myapp\n  - myapp\n`,
        'utf-8',
      );

      const known = new Set(['myapp']);
      const read = readJob(name);
      expect(read).not.toBeNull();
      // Grouping treats the duplicated file as one named project, not Cross-project.
      expect(computeProjectGroupKind(read!.projects, known)).toEqual({ kind: 'named', name: 'myapp' });
      expect(computeProjectGroup(read!.projects, known)).toBe('myapp');

      // Rewriting through the schema boundary canonicalizes persistence.
      writeJob(read!);
      const persisted = yaml.parse(fs.readFileSync(file, 'utf-8'));
      expect(persisted.projects).toEqual(['myapp']);
    } finally {
      deleteJob(name);
    }
  });
});

describe('validateJob — per-routine strategy + host:auto (RUSH-2719)', () => {
  it('accepts each RUN_STRATEGIES value on an agent routine', () => {
    for (const strategy of ['pinned', 'available', 'balanced'] as const) {
      expect(validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', strategy }))).toEqual([]);
    }
  });

  it('rejects an unknown strategy value', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', strategy: 'chaotic' as never }));
    expect(errors.some((e) => e.startsWith('strategy must be one of:'))).toBe(true);
  });

  it('rejects strategy combined with an exact version pin', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: 'claude', strategy: 'balanced', version: '2.1.207' }));
    expect(errors.some((e) => e.includes('conflicts with version 2.1.207'))).toBe(true);
  });

  it('rejects strategy on a command routine (nothing to select)', () => {
    const errors = validateJob(baseJob({ schedule: '0 3 * * *', agent: undefined, prompt: undefined, command: 'echo ok', strategy: 'balanced' }));
    expect(errors.some((e) => e.includes('strategy only applies to agent routines'))).toBe(true);
  });

  it("accepts host: 'auto' under hostStrategy: fleet", () => {
    expect(validateJob(baseJob({
      schedule: '0 3 * * *', agent: 'claude', hostStrategy: 'fleet', host: 'auto', devices: ['zion'],
    }))).toEqual([]);
  });

  it("rejects host: 'auto' under hostStrategy: host — auto is a fire-time pick, not a machine", () => {
    const errors = validateJob(baseJob({
      schedule: '0 3 * * *', agent: 'claude', hostStrategy: 'host', host: 'auto', devices: ['zion'],
    }));
    expect(errors.some((e) => e.includes("host: auto requires hostStrategy: fleet"))).toBe(true);
  });
});
