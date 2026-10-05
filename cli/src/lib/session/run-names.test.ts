import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-runnames-'));
process.env.HOME = TEST_HOME;

const { recordRunName, buildRunNameMap, runNamesDir } = await import('./run-names.js');

describe('run-names sidecar', () => {
  it('records a name keyed by session id and reads it back into the map', () => {
    recordRunName({ sessionId: 'sess-1', name: 'fix-bug', agent: 'claude', cwd: '/x' });
    recordRunName({ sessionId: 'sess-2', name: 'codex-probe', agent: 'codex' });
    const map = buildRunNameMap();
    expect(map.get('sess-1')).toBe('fix-bug');
    expect(map.get('sess-2')).toBe('codex-probe');
  });

  it('is a no-op without both a session id and a name (unnamed runs unaffected)', () => {
    recordRunName({ sessionId: 'sess-3', name: '', agent: 'claude' });
    recordRunName({ sessionId: '', name: 'orphan', agent: 'claude' });
    const map = buildRunNameMap();
    expect(map.has('sess-3')).toBe(false);
    expect([...map.values()]).not.toContain('orphan');
  });

  it('returns an empty map when the dir does not exist yet', () => {
    fs.rmSync(runNamesDir(), { recursive: true, force: true });
    expect(buildRunNameMap().size).toBe(0);
  });
});
