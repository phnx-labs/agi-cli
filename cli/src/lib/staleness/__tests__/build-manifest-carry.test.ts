/** RUSH-2320 #3: buildManifest carries still-fresh fingerprints from a previous manifest, with
 * no re-hash of unchanged sources. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  newFixture, writeFile,
  type Fixture,
  AGENT, VERSION,
} from './_fixtures.js';

const HARNESS_TS = path.join(__dirname, '_harness.ts');

function writeSkill(fx: Fixture, name: string, body = 'skill body'): void {
  writeFile(fx, 'user', `skills/${name}/SKILL.md`, body);
}

function call(fx: Fixture, op: object): { reused?: string[]; manifest?: unknown } {
  const out = execFileSync('bun', [HARNESS_TS, JSON.stringify(op)], {
    env: { ...process.env, HOME: fx.home },
    encoding: 'utf-8',
  });
  return JSON.parse(out) as { reused?: string[]; manifest?: unknown };
}

describe('buildManifest carry-forward (RUSH-2320 #3)', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('carry'); });
  afterEach(() => fx.cleanup());

  it('reuses still-fresh skill entries by object identity', () => {
    writeSkill(fx, 'one', 'stable body');
    writeSkill(fx, 'two', 'also stable');

    call(fx, { cmd: 'build', agent: AGENT, version: VERSION, cwd: fx.projectRoot });
    const second = call(fx, {
      cmd: 'buildCarry',
      agent: AGENT,
      version: VERSION,
      cwd: fx.projectRoot,
    });

    expect(new Set(second.reused)).toEqual(new Set(['one', 'two']));
  });

  it('rebuilds a skill whose content changed; carries the rest', () => {
    writeSkill(fx, 'stable', 'keep');
    writeSkill(fx, 'changing', 'v1');
    call(fx, { cmd: 'build', agent: AGENT, version: VERSION, cwd: fx.projectRoot });

    // Bump mtime + content so isFresh fails for "changing".
    const skillMd = path.join(fx.userDir, 'skills', 'changing', 'SKILL.md');
    // Ensure mtime advances on filesystems with 1s resolution.
    const past = new Date(Date.now() - 5_000);
    fs.utimesSync(skillMd, past, past);
    fs.writeFileSync(skillMd, 'v2');
    const now = new Date();
    fs.utimesSync(skillMd, now, now);

    const second = call(fx, {
      cmd: 'buildCarry',
      agent: AGENT,
      version: VERSION,
      cwd: fx.projectRoot,
    });

    expect(second.reused).toContain('stable');
    expect(second.reused).not.toContain('changing');
  });
});
