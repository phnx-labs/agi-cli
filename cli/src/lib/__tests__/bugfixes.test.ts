import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { symlinkAllowedDirs } from '../sandbox.js';
import { validateJob, parseAtTime, writeJob, readJob, deleteJob, resolveJobPrompt } from '../scheduling/routines.js';
import { cleanOrphanedPluginSkills } from '../plugins/plugins.js';

describe('Bug Fix: Path traversal in sandbox.ts', () => {
  let overlayHome: string;
  let allowedDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    // Point HOME at an isolated tmpdir so the test never touches the real home. sandbox.ts uses
    // os.homedir(), which reads $HOME on POSIX but USERPROFILE on Windows, so set both.
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-fakehome-')));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    overlayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
    fs.mkdirSync(path.join(fakeHome, '.agents-system'), { recursive: true });
    allowedDir = fs.mkdtempSync(path.join(fakeHome, '.agents-system', 'agents-cli-sandbox-allowed-'));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(overlayHome, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('should block path traversal via .. components', () => {
    symlinkAllowedDirs(overlayHome, ['~/../../../etc']);

    const entries = fs.readdirSync(overlayHome);
    const hasEtc = entries.some(e => e === 'etc' || e.includes('etc'));
    expect(hasEtc).toBe(false);
  });

  it('should block ~/../../../ style traversals', () => {
    symlinkAllowedDirs(overlayHome, ['~/../../..']);

    const entries = fs.readdirSync(overlayHome);
    expect(entries.length).toBe(0);
  });

  it('should allow valid paths under HOME', () => {
    symlinkAllowedDirs(
      overlayHome,
      [`~/.agents-system/${path.basename(allowedDir)}`],
    );

    const symlinkPath = path.join(overlayHome, '.agents-system', path.basename(allowedDir));
    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(symlinkPath)).toBe(allowedDir);
  });

  it('should block absolute paths outside HOME', () => {
    symlinkAllowedDirs(overlayHome, ['/etc', '/tmp', '/var']);

    const entries = fs.readdirSync(overlayHome);
    expect(entries.length).toBe(0);
  });
});

describe('Bug Fix: Cron expression validation', () => {
  it('should reject invalid cron expressions', () => {
    const errors = validateJob({
      name: 'test',
      schedule: '99 99 99 99 99',
      agent: 'claude',
      prompt: 'test',
    });
    expect(errors.some(e => e.includes('invalid cron expression'))).toBe(true);
  });

  it('should accept valid cron expressions', () => {
    const errors = validateJob({
      name: 'test',
      schedule: '0 9 * * 1-5',
      agent: 'claude',
      prompt: 'test',
    });
    expect(errors.some(e => e.includes('invalid cron expression'))).toBe(false);
  });

  it('should reject invalid agent names', () => {
    const errors = validateJob({
      name: 'test',
      schedule: '0 9 * * *',
      agent: 'fake-agent' as any,
      prompt: 'test',
    });
    expect(errors.some(e => e.includes('agent must be one of'))).toBe(true);
  });

  it('should accept openclaw as a valid agent', () => {
    const errors = validateJob({
      name: 'test',
      schedule: '0 9 * * *',
      agent: 'openclaw',
      prompt: 'test',
    });
    expect(errors.some(e => e.includes('agent must be one of'))).toBe(false);
  });
});

describe('Bug Fix: Timezone day resolution', () => {
  it('should resolve {day} correctly for a timezone', () => {
    const config = {
      name: 'test',
      schedule: '0 9 * * *',
      agent: 'claude' as const,
      mode: 'plan' as const,
      effort: 'auto' as const,
      timeout: '30m',
      enabled: true,
      prompt: 'Today is {day}',
      timezone: 'America/New_York',
    };

    const resolved = resolveJobPrompt(config);
    const validDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayFound = validDays.some(day => resolved.includes(day));
    expect(dayFound).toBe(true);
  });

  it('should resolve {day} using Intl API for correct timezone', () => {
    const config = {
      name: 'test',
      schedule: '0 9 * * *',
      agent: 'claude' as const,
      mode: 'plan' as const,
      effort: 'auto' as const,
      timeout: '30m',
      enabled: true,
      prompt: '{day}',
      timezone: 'UTC',
    };

    const resolved = resolveJobPrompt(config);
    const validDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    expect(validDays).toContain(resolved);
  });
});

describe('Bug Fix: One-shot job runOnce field', () => {
  it('parseAtTime should return runOnce: true', () => {
    const result = parseAtTime('14:30');
    expect(result).not.toBeNull();
    expect(result!.runOnce).toBe(true);
  });

  it('parseAtTime with date should return runOnce: true', () => {
    const result = parseAtTime('2030-06-15 09:00');
    expect(result).not.toBeNull();
    expect(result!.runOnce).toBe(true);
  });

  it('runOnce should survive write/read cycle', () => {
    const testJobName = '__test-runonce-bugfix__';
    try {
      writeJob({
        name: testJobName,
        schedule: '30 14 25 3 *',
        agent: 'claude',
        mode: 'plan',
        effort: 'auto',
        timeout: '30m',
        enabled: true,
        prompt: 'test',
        runOnce: true,
      });

      const read = readJob(testJobName);
      expect(read).not.toBeNull();
      expect(read!.runOnce).toBe(true);
    } finally {
      deleteJob(testJobName);
    }
  });
});

describe('Bug Fix: Plugin orphan cleanup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-orphan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should remove orphaned plugin skill dirs', () => {
    const skillsDir = path.join(tempDir, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    fs.mkdirSync(path.join(skillsDir, 'active-plugin--skill1'));
    fs.writeFileSync(path.join(skillsDir, 'active-plugin--skill1', 'SKILL.md'), 'test');

    fs.mkdirSync(path.join(skillsDir, 'deleted-plugin--skill1'));
    fs.writeFileSync(path.join(skillsDir, 'deleted-plugin--skill1', 'SKILL.md'), 'test');

    fs.mkdirSync(path.join(skillsDir, 'regular-skill'));
    fs.writeFileSync(path.join(skillsDir, 'regular-skill', 'SKILL.md'), 'test');

    const activePlugins = new Set(['active-plugin']);
    const removed = cleanOrphanedPluginSkills('claude', tempDir, activePlugins);

    expect(removed).toEqual(['deleted-plugin--skill1']);
    expect(fs.existsSync(path.join(skillsDir, 'active-plugin--skill1'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'deleted-plugin--skill1'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'regular-skill'))).toBe(true);
  });

  it('should not touch non-plugin dirs (no -- separator)', () => {
    const skillsDir = path.join(tempDir, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    fs.mkdirSync(path.join(skillsDir, 'my-normal-skill'));
    fs.writeFileSync(path.join(skillsDir, 'my-normal-skill', 'SKILL.md'), 'test');

    const removed = cleanOrphanedPluginSkills('claude', tempDir, new Set());

    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(skillsDir, 'my-normal-skill'))).toBe(true);
  });
});
