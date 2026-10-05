import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile,
  build, isStale, list,
  type Fixture,
} from './_fixtures.js';
import * as fs from 'fs';
import * as path from 'path';

function writeWorkflow(fx: Fixture, layer: 'project'|'user'|'system', name: string, body = '# workflow body'): string {
  return path.dirname(writeFile(fx, layer, `workflows/${name}/WORKFLOW.md`, body));
}

describe('staleness e2e: workflows', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('wf'); });
  afterEach(()  => fx.cleanup());

  it('empty -> empty list, clean', () => {
    expect(list(fx, 'workflows')).toEqual([]);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('lists across all three layers', () => {
    writeWorkflow(fx, 'system',  'sys');
    writeWorkflow(fx, 'user',    'usr');
    writeWorkflow(fx, 'project', 'proj');
    expect(new Set(list(fx, 'workflows'))).toEqual(new Set(['sys', 'usr', 'proj']));
  });

  it('workflow added -> stale', () => {
    writeWorkflow(fx, 'user', 'one');
    build(fx);
    writeWorkflow(fx, 'project', 'two');
    expect(isStale(fx)).toBe(true);
  });

  it('workflow removed -> stale', () => {
    writeWorkflow(fx, 'user', 'one');
    writeWorkflow(fx, 'user', 'two');
    build(fx);
    fs.rmSync(path.join(fx.userDir, 'workflows/two'), { recursive: true });
    expect(isStale(fx)).toBe(true);
  });

  it('WORKFLOW.md content changed -> stale', () => {
    writeWorkflow(fx, 'user', 'one', 'v1');
    build(fx);
    writeWorkflow(fx, 'user', 'one', 'v2 - more content here');
    expect(isStale(fx)).toBe(true);
  });

  it('file added inside workflow dir -> stale', () => {
    writeWorkflow(fx, 'user', 'one');
    build(fx);
    fs.writeFileSync(path.join(fx.userDir, 'workflows/one/script.sh'), '#!/bin/bash');
    expect(isStale(fx)).toBe(true);
  });

  it('layer swap (user -> project of same name) -> stale', () => {
    writeWorkflow(fx, 'user', 'same');
    build(fx);
    writeWorkflow(fx, 'project', 'same');
    expect(isStale(fx)).toBe(true);
  });

  it('directories without WORKFLOW.md are not workflows', () => {
    fs.mkdirSync(path.join(fx.userDir, 'workflows/not-wf'), { recursive: true });
    fs.writeFileSync(path.join(fx.userDir, 'workflows/not-wf/something.md'), 'no');
    expect(list(fx, 'workflows')).toEqual([]);
  });

  it('v1 manifests with no workflows field: workflow appears -> stale, then clean after rebuild', () => {
    build(fx);
    expect(isStale(fx)).toBe(false);
    writeWorkflow(fx, 'user', 'fresh');
    expect(isStale(fx)).toBe(true);
    build(fx);
    expect(isStale(fx)).toBe(false);
  });
});
