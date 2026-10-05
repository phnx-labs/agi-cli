import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { capableAgents } from './capabilities.js';


describe('hooks capability <-> registrar completeness', () => {
  it('every hooks-capable agent has a branch in registerHooksToSettings', () => {
    const hooksSource = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/hooks/install.ts'), 'utf-8');
    const start = hooksSource.indexOf('export function registerHooksToSettings');
    expect(start).toBeGreaterThan(-1);
    const nextDecl = hooksSource.indexOf('\nconst OPENCODE_DIRECT_EVENT_MAP', start);
    expect(nextDecl).toBeGreaterThan(start);
    const registrarBody = hooksSource.slice(start, nextDecl);

    const missing = capableAgents('hooks').filter(
      (id) => !registrarBody.includes(`agentId === '${id}'`)
    );

    expect(missing).toEqual([]);
  });
});
