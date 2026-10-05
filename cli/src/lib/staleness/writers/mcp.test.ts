import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../../platform/index.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mcp-writer-'));
  tempDirs.push(dir);
  return dir;
}

/** A HOME holding one user-scope MCP server, ready to sync. */
function homeWithOneServer(): string {
  const home = makeTempHome();
  const userMcpDir = path.join(home, '.agents', 'mcp');
  fs.mkdirSync(userMcpDir, { recursive: true });
  fs.writeFileSync(
    path.join(userMcpDir, 'srv.yaml'),
    ['name: srv', 'transport: stdio', 'command: node', 'args: ["s.js"]', ''].join('\n'),
    'utf-8'
  );
  return home;
}

/** Run the built writer against `home` and return its WriteResult, through `getWriter` like
 * `syncResourcesToVersion`. Importing `writers/mcp.js` directly as an entry point trips the
 * module-init cycle `lazy-map.ts` documents. */
function write(home: string, agent: string): { synced: string[]; errors?: string[] } {
  const moduleUrl = pathToFileURL(path.resolve('dist/lib/staleness/registry.js')).href;
  const versionHome = path.join(home, '.agents', '.history', 'versions', agent, '1.0.0', 'home');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { getWriter } from ${JSON.stringify(moduleUrl)};
    const w = getWriter('mcp', ${JSON.stringify(agent)});
    console.log(JSON.stringify(w.write({
      version: '1.0.0',
      versionHome: ${JSON.stringify(versionHome)},
      selection: ['srv'],
      cwd: process.cwd(),
    })));
  `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  if (child.status !== 0) throw new Error(child.stderr || 'writer probe failed');
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('mcp writer surfaces a refusal instead of swallowing it', () => {
  // RUSH-2677: `installMcpServers` reported the refusal but this writer discarded its `errors`, so
  // a harness with no config writer produced `synced: []`, indistinguishable from 'nothing to
  // sync', and `agents sync` printed nothing.
  it.skipIf(IS_WINDOWS)('forwards the reason a harness could not be written', () => {
    const result = write(homeWithOneServer(), 'copilot');
    expect(result.synced).toEqual([]);
    expect(result.errors, 'the refusal must reach the caller').toBeTruthy();
    expect(result.errors!.join('\n')).toContain('cannot write MCP config');
    expect(result.errors!.join('\n')).toContain('copilot');
  });

  it.skipIf(IS_WINDOWS)('reports no errors for a harness it can write', () => {
    const result = write(homeWithOneServer(), 'droid');
    expect(result.synced).toEqual(['srv']);
    expect(result.errors).toBeUndefined();
  });
});
