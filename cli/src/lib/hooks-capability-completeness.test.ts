/** Pins the hooks capability table to `registerHooksToSettings`'s per-agent branches so they
 * cannot drift as for OpenClaw (RUSH-2122): `hooks: true` with no registrar case meant `agents
 * sync openclaw` installed zero hooks while `agents doctor` reported it capable. */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { capableAgents } from './capabilities.js';

describe('hooks capability <-> registrar completeness', () => {
  it('every hooks-capable agent has a branch in registerHooksToSettings', () => {
    const hooksSource = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/hooks/install.ts'), 'utf-8');
    const start = hooksSource.indexOf('export function registerHooksToSettings');
    expect(start).toBeGreaterThan(-1);
    // The function's final `return { registered: [], errors: [] };` (the openclaw-shaped
    // fallthrough) precedes the next top-level declaration; slice up to there so the search does
    // not spill into per-agent registrar bodies that mention `agentId` in comments.
    const nextDecl = hooksSource.indexOf('\nconst OPENCODE_DIRECT_EVENT_MAP', start);
    expect(nextDecl).toBeGreaterThan(start);
    const registrarBody = hooksSource.slice(start, nextDecl);

    const missing = capableAgents('hooks').filter(
      (id) => !registrarBody.includes(`agentId === '${id}'`)
    );

    expect(missing).toEqual([]);
  });
});
