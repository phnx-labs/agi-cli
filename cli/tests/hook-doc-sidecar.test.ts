import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listHookEntriesFromDir } from '../src/lib/hooks/install.js';

let TMP: string;
beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-sidecar-')); });
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

function write(name: string, content = '#!/bin/sh\n'): void {
  fs.writeFileSync(path.join(TMP, name), content);
}

describe('listHookEntriesFromDir — doc sidecars', () => {
  it('does NOT treat a .md doc sibling as the hook dataFile', () => {
    write('git-guard.sh');
    write('git-guard.md', '# docs\n');
    const entries = listHookEntriesFromDir(TMP);
    const g = entries.find((e) => e.name === 'git-guard');
    expect(g).toBeDefined();
    expect(g!.scriptPath).toBe(path.join(TMP, 'git-guard.sh'));
    expect(g!.dataFile).toBeUndefined();
  });

  it('still treats a structured .yaml sibling as a real dataFile', () => {
    write('promptcut.sh');
    write('promptcut.yaml', 'a: 1\n');
    const entries = listHookEntriesFromDir(TMP);
    const p = entries.find((e) => e.name === 'promptcut');
    expect(p?.dataFile).toBe(path.join(TMP, 'promptcut.yaml'));
  });

  it('a lone README.md (no script) is not a hook at all', () => {
    write('README.md', '# readme\n');
    expect(listHookEntriesFromDir(TMP)).toHaveLength(0);
  });
});
