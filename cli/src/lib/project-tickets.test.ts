import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linearArgv, runLinearFor } from './project-tickets.js';
import type { ProjectDef } from './projects.js';

const AGI_UI: ProjectDef = { name: 'agi-ui', linear: { projectId: '2a56fa44-adc9-45be-acb5-1d20ad07afcb', name: 'AGI UI' } } as ProjectDef;

function fakeLinear(script: string): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-linear-'));
  const bin = path.join(dir, 'linear');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return { ...process.env, PATH: `${dir}:/usr/bin:/bin` };
}

describe('linearArgv', () => {
  it('lists the project by its recorded id, never its name', () => {
    expect(linearArgv(AGI_UI, { kind: 'list' }, true)).toEqual(['tasks', '--project', '2a56fa44-adc9-45be-acb5-1d20ad07afcb', '--json']);
  });

  it('refuses a project with no Linear link, naming the link command', () => {
    expect(() => linearArgv({ name: 'bare' } as ProjectDef, { kind: 'list' }, true)).toThrow('agents projects link bare --linear');
  });

  it('refuses an id that is not an issue id, so a flag cannot pass as one', () => {
    expect(() => linearArgv(AGI_UI, { kind: 'view', id: '--all' }, true)).toThrow('not a Linear issue id');
  });

  it('comments as one argv element, whatever the text holds', () => {
    expect(linearArgv(AGI_UI, { kind: 'comment', id: 'PHNX-1', text: 'a "b" $c' }, false)).toEqual(['update', 'PHNX-1', '--comment=a "b" $c']);
  });
});

describe('runLinearFor', () => {
  it('passes linear-cli JSON through unchanged', () => {
    const env = fakeLinear(`echo "$@"`);
    const res = runLinearFor(AGI_UI, { kind: 'goals' }, true, env);
    expect(res).toEqual({ status: 0, stdout: 'goals --json\n', stderr: '' });
  });

  it('adds the relink command when linear rejects the recorded project id', () => {
    const env = fakeLinear(`echo "Error: project $3 is not a live project on this team." >&2; exit 1`);
    const res = runLinearFor(AGI_UI, { kind: 'list' }, true, env);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe('Error: project 2a56fa44-adc9-45be-acb5-1d20ad07afcb is not a live project on this team.\nRelink it: agents projects link agi-ui --linear\n');
  });

  it('says linear-cli is missing instead of throwing', () => {
    const res = runLinearFor(AGI_UI, { kind: 'goals' }, true, { ...process.env, PATH: '/nonexistent' });
    expect(res).toEqual({ status: 1, stdout: '', stderr: 'linear CLI not found on PATH. Install linear-cli.\n' });
  });
});
