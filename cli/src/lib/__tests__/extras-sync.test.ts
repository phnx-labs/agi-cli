import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function runInTempHome(scriptBody: string): Record<string, unknown> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'extras-sync-'));
  try {
    const script = `
      import * as fs from 'fs';
      import * as path from 'path';
      import { syncResourcesToVersion } from './src/lib/installations/versions.ts';
      import { runLaunchSync } from './src/lib/project-launch.ts';

      const home = process.env.HOME;
      if (!home) throw new Error('HOME missing');
      const userDir = path.join(home, '.agents');
      const extrasRepo = path.join(home, '.agents-extras'); // default dir for alias "extras"
      const projectRoot = path.join(home, 'project');
      const version = '2.1.141';
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });

      // Register the extras repo as an ENABLED extra in agents.yaml.
      const enableExtras = () => fs.writeFileSync(
        path.join(userDir, 'agents.yaml'),
        ['extraRepos:', '  extras:', '    enabled: true', '    url: "x://extras"', ''].join('\\n'),
      );

      ${scriptBody}
    `;
    const out = execFileSync('bun', ['--eval', script], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    const lines = out.trim().split('\n').filter((l) => l.trim().startsWith('{'));
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('extras repo resource sync', () => {
  it('writes a top-level command from an enabled extras repo into the version home', () => {
    const result = runInTempHome(`
      enableExtras();
      fs.mkdirSync(path.join(extrasRepo, 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(extrasRepo, 'commands', 'browser.md'),
        ['---', 'description: Browser', '---', '', 'browser body'].join('\\n'),
      );
      // A baseline user command proves the extras one is ADDED, not substituted.
      fs.writeFileSync(
        path.join(userDir, 'commands', 'plan.md'),
        ['---', 'description: Plan', '---', '', 'plan body'].join('\\n'),
      );

      syncResourcesToVersion('claude', version, undefined, { cwd: projectRoot, force: true });

      const dir = path.join(userDir, '.history', 'versions', 'claude', version, 'home', '.claude', 'commands');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      console.log(JSON.stringify({ files }));
    `) as { files: string[] };

    expect(result.files).toContain('browser.md');
    expect(result.files).toContain('plan.md');
  });

  it('synthesizes an agents-extras marketplace from an enabled extras repo’s plugins', () => {
    const result = runInTempHome(`
      enableExtras();
      const mkPlugin = (name) => {
        const d = path.join(extrasRepo, 'plugins', name, '.claude-plugin');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({ name, version: '0.1.0', description: name + ' plugin' }));
      };
      mkPlugin('git');
      mkPlugin('code');

      const versionHome = path.join(userDir, '.history', 'versions', 'claude', version, 'home');
      fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });

      const r = runLaunchSync({ agent: 'claude', version, cwd: projectRoot });

      const mf = path.join(versionHome, '.claude', 'plugins', 'marketplaces', 'agents-extras', '.claude-plugin', 'marketplace.json');
      const onDisk = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf-8')).plugins.map((p) => p.name).sort() : [];
      console.log(JSON.stringify({ marketplaces: r.marketplaces, onDisk }));
    `) as { marketplaces: Record<string, string[]>; onDisk: string[] };

    expect(result.marketplaces['agents-extras']).toEqual(['code', 'git']);
    expect(result.onDisk).toEqual(['code', 'git']);
  });
});
