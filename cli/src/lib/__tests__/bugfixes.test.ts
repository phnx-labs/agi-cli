import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cleanOrphanedPluginSkills } from '../plugins/plugins.js';

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
