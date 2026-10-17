import { spawnSync } from 'child_process';
import type { ProjectDef } from './projects.js';

export type TicketsVerb =
  | { kind: 'list' }
  | { kind: 'view'; id: string }
  | { kind: 'comment'; id: string; text: string }
  | { kind: 'goals' };

const ISSUE_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export function linearArgv(def: ProjectDef, verb: TicketsVerb, json: boolean): string[] {
  const out = json ? ['--json'] : [];
  if (verb.kind === 'goals') return ['goals', ...out];
  if (verb.kind === 'list') {
    const id = def.linear?.projectId;
    if (!id) throw new Error(`Project "${def.name}" has no Linear project. Link one: agents projects link ${def.name} --linear`);
    return ['tasks', '--project', id, ...out];
  }
  if (!ISSUE_ID.test(verb.id)) throw new Error(`"${verb.id}" is not a Linear issue id like PHNX-123.`);
  if (verb.kind === 'view') return ['tasks', verb.id, ...out];
  if (!verb.text.trim()) throw new Error('A comment needs text.');
  return ['update', verb.id, `--comment=${verb.text}`];
}

export interface LinearRun {
  status: number;
  stdout: string;
  stderr: string;
}

export function runLinearFor(def: ProjectDef, verb: TicketsVerb, json: boolean, env: NodeJS.ProcessEnv = process.env): LinearRun {
  const argv = linearArgv(def, verb, json);
  const res = spawnSync('linear', argv, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    const missing = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    return { status: 1, stdout: '', stderr: missing ? 'linear CLI not found on PATH. Install linear-cli.\n' : `${res.error.message}\n` };
  }
  let stderr = res.stderr ?? '';
  const id = def.linear?.projectId;
  if (res.status !== 0 && verb.kind === 'list' && id && stderr.includes(id)) {
    stderr += `Relink it: agents projects link ${def.name} --linear\n`;
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr };
}
