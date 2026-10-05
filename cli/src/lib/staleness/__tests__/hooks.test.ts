import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile, writeExecFile, removeFile,
  build, isStale, list,
  type Fixture,
} from './_fixtures.js';
import * as fs from 'fs';
import * as path from 'path';

describe('staleness e2e: hooks', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('hook'); });
  afterEach(()  => fx.cleanup());

  it('empty -> empty list, clean manifest', () => {
    expect(list(fx, 'hooks')).toEqual([]);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('only executable files count as hooks (README, data are excluded)', () => {
    writeExecFile(fx, 'system', 'hooks/00-real.sh', '#!/bin/bash\necho hi');
    writeFile(fx, 'system',     'hooks/README.md',  '# docs');
    writeFile(fx, 'system',     'hooks/data.yaml',  'k: v');
    expect(list(fx, 'hooks')).toEqual(['00-real.sh']);
  });

  it('PROJECT LAYER IS EXCLUDED (security): a project hook is never listed', () => {
    writeExecFile(fx, 'project', 'hooks/evil.sh', '#!/bin/bash\nrm -rf /');
    writeExecFile(fx, 'user',    'hooks/safe.sh', '#!/bin/bash\necho ok');
    const names = list(fx, 'hooks');
    expect(names).toContain('safe.sh');
    expect(names).not.toContain('evil.sh');
  });

  it('PROJECT-shadowing user hook still resolves to USER source (manifest matches the sync writer)', () => {
    writeExecFile(fx, 'project', 'hooks/same.sh', '#!/bin/bash\necho project');
    writeExecFile(fx, 'user',    'hooks/same.sh', '#!/bin/bash\necho user');
    build(fx);
    writeExecFile(fx, 'user',    'hooks/same.sh', '#!/bin/bash\necho user-v2');
    expect(isStale(fx)).toBe(true);
  });

  it('PROJECT-shadowing user hook: mutating only project does NOT trigger stale (project ignored)', () => {
    writeExecFile(fx, 'user',    'hooks/same.sh', '#!/bin/bash\necho user');
    build(fx);
    writeExecFile(fx, 'project', 'hooks/same.sh', '#!/bin/bash\necho project');
    expect(isStale(fx)).toBe(false);
  });

  it('clean -> not stale', () => {
    writeExecFile(fx, 'user',   'hooks/foo.sh', '#!/bin/bash');
    writeExecFile(fx, 'system', 'hooks/bar.py', '#!/usr/bin/env python');
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('hook added -> stale', () => {
    writeExecFile(fx, 'system', 'hooks/foo.sh', '#!/bin/bash');
    build(fx);
    writeExecFile(fx, 'user',   'hooks/bar.sh', '#!/bin/bash');
    expect(isStale(fx)).toBe(true);
  });

  it('hook removed -> stale', () => {
    writeExecFile(fx, 'user', 'hooks/foo.sh', '#!/bin/bash');
    writeExecFile(fx, 'user', 'hooks/bar.sh', '#!/bin/bash');
    build(fx);
    removeFile(fx, 'user', 'hooks/bar.sh');
    expect(isStale(fx)).toBe(true);
  });

  it('hook content changed -> stale', () => {
    writeExecFile(fx, 'user', 'hooks/foo.sh', '#!/bin/bash\necho original');
    build(fx);
    writeExecFile(fx, 'user', 'hooks/foo.sh', '#!/bin/bash\necho changed');
    expect(isStale(fx)).toBe(true);
  });

  it('layer swap inside hook scope (system -> user of same name) -> stale', () => {
    writeExecFile(fx, 'system', 'hooks/same.sh', '#!/bin/bash\necho sys');
    build(fx);
    writeExecFile(fx, 'user',   'hooks/same.sh', '#!/bin/bash\necho usr');
    expect(isStale(fx)).toBe(true);
  });

  it('file with script extension counts as a hook regardless of exec bit', () => {
    writeFile(fx, 'user', 'hooks/foo.sh', '#!/bin/bash\necho hi');
    expect(list(fx, 'hooks')).toEqual(['foo.sh']);
  });

  it.skipIf(process.platform === 'win32')('file with no extension counts as a hook only when exec bit is set', () => {
    writeFile(fx, 'user', 'hooks/no-ext', '#!/bin/bash\necho hi');
    expect(list(fx, 'hooks')).toEqual([]);
    fs.chmodSync(path.join(fx.userDir, 'hooks/no-ext'), 0o755);
    expect(list(fx, 'hooks')).toEqual(['no-ext']);
  });

  it('data file with exec bit (promptcuts.yaml regression) is NOT a hook', () => {
    writeExecFile(fx, 'user', 'hooks/promptcuts.yaml', 'shortcuts: {}\n');
    writeExecFile(fx, 'user', 'hooks/README.md',       '# docs');
    writeExecFile(fx, 'user', 'hooks/config.json',     '{}');
    expect(list(fx, 'hooks')).toEqual([]);
  });
});
