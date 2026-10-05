import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../../platform/index.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-subagents-writer-'));
  tempDirs.push(dir);
  return dir;
}

function writeCentralSubagent(home: string, name: string, agentMd: string): void {
  const dir = path.join(home, '.agents', 'subagents', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENT.md'), agentMd, 'utf-8');
}

/** Run the built subagents writer against `home` via `getWriter`, in a child with `HOME` at the
 * temp dir so `listInstalledSubagents` reads the fixture (resolved from HOME at module init).
 * Direct import trips the `lazy-map.ts` cycle. */
function write(home: string, agent: string, selection: string[]): { synced: string[]; paths: string[]; errors?: string[] } {
  const moduleUrl = pathToFileURL(path.resolve('dist/lib/staleness/registry.js')).href;
  const versionHome = path.join(home, '.agents', '.history', 'versions', agent, '1.0.0', 'home');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { getWriter } from ${JSON.stringify(moduleUrl)};
    const w = getWriter('subagents', ${JSON.stringify(agent)});
    console.log(JSON.stringify(w.write({
      version: '1.0.0',
      versionHome: ${JSON.stringify(versionHome)},
      selection: ${JSON.stringify(selection)},
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

// PHNX-3187: the writer `continue`d past unresolvable names and swallowed per-item write failures,
// so an unparseable AGENT.md (git-CRLF on Windows) gave `synced: []`, like 'nothing selected', and
// `agents doctor --fix` reported an unactionable 'hold'.
describe('subagents writer surfaces a refusal instead of swallowing it', () => {
  it.skipIf(IS_WINDOWS)('reports the reason a requested subagent is not discoverable', () => {
    const home = makeTempHome();
    writeCentralSubagent(home, 'broken', 'no frontmatter here, just prose.\n');

    const result = write(home, 'claude', ['broken']);
    expect(result.synced).toEqual([]);
    expect(result.errors, 'the refusal must reach the caller').toBeTruthy();
    expect(result.errors!.join('\n')).toContain("subagent 'broken'");
    expect(result.errors!.join('\n')).toContain('no parseable AGENT.md');
  });

  it.skipIf(IS_WINDOWS)('reports no errors for a subagent it can write', () => {
    const home = makeTempHome();
    writeCentralSubagent(
      home,
      'reviewer',
      '---\nname: reviewer\ndescription: Reviews the diff\nmodel: opus\n---\n\nYou review code.\n'
    );

    const result = write(home, 'claude', ['reviewer']);
    expect(result.synced).toEqual(['reviewer']);
    expect(result.errors).toBeUndefined();
  });
});
