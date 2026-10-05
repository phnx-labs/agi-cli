import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-test-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});



function runInHome(body: string): Record<string, unknown> {
  const script = String.raw`
    import * as fs from 'fs';
    import * as path from 'path';
    import { planUninstall, executeUninstall } from './src/lib/uninstall.ts';
    const home = process.env.HOME;
    const userDir = path.join(home, '.agents');
    const versionsRoot = path.join(userDir, '.history', 'versions');
    const backupsRoot = path.join(userDir, '.history', 'backups');
    const shimsDir = path.join(userDir, '.cache', 'shims');

    fs.mkdirSync(shimsDir, { recursive: true });




    function adopt(agent, configDirName, version, managedContent) {
      const versionHome = path.join(versionsRoot, agent, version, 'home', configDirName);
      fs.mkdirSync(versionHome, { recursive: true });
      fs.writeFileSync(path.join(versionHome, 'marker'), managedContent);
      const type = process.platform === 'win32' ? 'junction' : undefined;
      fs.symlinkSync(versionHome, path.join(home, configDirName), type);
      return versionHome;
    }
    function backup(agent, ts, originalContent) {
      const dir = path.join(backupsRoot, agent, String(ts));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'marker'), originalContent);
    }



    function syncResource(agent, configDirName, version, kind, name, content) {
      const central = path.join(userDir, kind, name);
      fs.mkdirSync(central, { recursive: true });
      fs.writeFileSync(path.join(central, 'body'), content);
      const versionHome = path.join(versionsRoot, agent, version, 'home', configDirName);
      const linkDir = path.join(versionHome, kind);
      fs.mkdirSync(linkDir, { recursive: true });
      fs.symlinkSync(central, path.join(linkDir, name), process.platform === 'win32' ? 'junction' : undefined);
    }
    ${body}
  `;




  const out = execFileSync('bun', ['--eval', script], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home },
    encoding: 'utf-8',
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
}

describe('uninstall restores adopted configs and never touches un-adopted ones', () => {
  it('restores an adopted config from its backup and leaves a real un-adopted dir untouched', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '1.0.0', 'MANAGED');
      backup('claude', 1700000000000, 'ORIGINAL_CLAUDE');


      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'ORIGINAL_CODEX');


      const rc = path.join(home, '.zshrc');
      fs.writeFileSync(rc, '# agents-cli: version-managed agent CLIs\nexport PATH="' + shimsDir + ':$PATH"\nexport KEEP=1\n');

      const plan = planUninstall();
      const res = executeUninstall(plan, { purge: false, timestamp: 42 });

      const claudePath = path.join(home, '.claude');
      const rcAfter = fs.readFileSync(rc, 'utf-8');
      console.log(JSON.stringify({
        codexKind: plan.configs.find(c => c.agent === 'codex').kind,
        claudeKind: plan.configs.find(c => c.agent === 'claude').kind,
        claudeIsRealDir: fs.lstatSync(claudePath).isDirectory() && !fs.lstatSync(claudePath).isSymbolicLink(),
        claudeContent: fs.readFileSync(path.join(claudePath, 'marker'), 'utf-8'),
        codexContent: fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8'),
        agentsMovedAside: fs.existsSync(userDir + '.removed-42') && !fs.existsSync(userDir),
        rcStrippedButKept: !rcAfter.includes('version-managed') && rcAfter.includes('KEEP=1'),
        errors: res.errors,
      }));
    `);

    expect(result.claudeKind).toBe('restore-backup');

    expect(result.codexKind).toBe('leave-real');
    expect(result.claudeIsRealDir).toBe(true);
    expect(result.claudeContent).toBe('ORIGINAL_CLAUDE');
    expect(result.codexContent).toBe('ORIGINAL_CODEX');
    expect(result.agentsMovedAside).toBe(true);
    expect(result.rcStrippedButKept).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('restores from the version home when there is no backup (importAgent case), stripping resource symlinks so nothing dangles', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '2.0.0', 'IMPORTED_ORIGINAL');


      syncResource('claude', '.claude', '2.0.0', 'skills', 'my-skill', 'SKILL_BODY');
      const plan = planUninstall();
      const res = executeUninstall(plan, { purge: false, timestamp: 7 });
      const claudePath = path.join(home, '.claude');
      const skillLink = path.join(claudePath, 'skills', 'my-skill');
      let skillState = 'absent';
      try {
        const st = fs.lstatSync(skillLink);
        skillState = st.isSymbolicLink() ? (fs.existsSync(skillLink) ? 'live-symlink' : 'dangling-symlink') : 'real';
      } catch { skillState = 'absent'; }
      console.log(JSON.stringify({
        kind: plan.configs.find(c => c.agent === 'claude').kind,
        isRealDir: fs.lstatSync(claudePath).isDirectory() && !fs.lstatSync(claudePath).isSymbolicLink(),
        content: fs.readFileSync(path.join(claudePath, 'marker'), 'utf-8'),
        skillState,
        errors: res.errors,
      }));
    `);
    expect(result.kind).toBe('restore-version-home');
    expect(result.isRealDir).toBe(true);
    expect(result.content).toBe('IMPORTED_ORIGINAL');

    expect(result.skillState).toBe('absent');
    expect(result.errors).toEqual([]);
  });

  it('downgrades --purge to a recoverable move-aside when a restore step errors (no sole-copy loss)', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '2.0.0', 'IMPORTED_ORIGINAL');
      const plan = planUninstall();


      fs.rmSync(plan.configs.find(c => c.agent === 'claude').source, { recursive: true, force: true });
      const res = executeUninstall(plan, { purge: true, timestamp: 99 });
      console.log(JSON.stringify({
        disposition: res.agentsDir.disposition,
        purgeDowngraded: res.purgeDowngraded,
        hadError: res.errors.length > 0,
        agentsPreserved: fs.existsSync(userDir + '.removed-99') && !fs.existsSync(userDir),
      }));
    `);
    expect(result.hadError).toBe(true);
    expect(result.purgeDowngraded).toBe(true);
    expect(result.disposition).toBe('moved');
    expect(result.agentsPreserved).toBe(true);
  });

  it('leaves a foreign symlink (not into our versions dir) untouched', () => {
    const result = runInHome(String.raw`

      const foreign = path.join(home, 'my-real-claude');
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'marker'), 'USER_OWNED');
      fs.symlinkSync(foreign, path.join(home, '.claude'), process.platform === 'win32' ? 'junction' : undefined);
      const plan = planUninstall();
      const res = executeUninstall(plan, { purge: false, timestamp: 5 });
      const link = path.join(home, '.claude');
      console.log(JSON.stringify({
        kind: plan.configs.find(c => c.agent === 'claude').kind,
        stillSymlink: fs.lstatSync(link).isSymbolicLink(),
        target: fs.readlinkSync(link),
        content: fs.readFileSync(path.join(link, 'marker'), 'utf-8'),
        errors: res.errors,
      }));
    `);
    expect(result.kind).toBe('leave-foreign');
    expect(result.stillSymlink).toBe(true);
    expect(result.content).toBe('USER_OWNED');
    expect(result.errors).toEqual([]);
  });

  it('removes the legacy ~/.agents-system back-compat link (junction on Windows) and reports it', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '1.0.0', 'MANAGED');
      backup('claude', 1700000000000, 'ORIGINAL_CLAUDE');


      const sysTarget = path.join(userDir, '.system');
      fs.mkdirSync(sysTarget, { recursive: true });
      fs.writeFileSync(path.join(sysTarget, 'marker'), 'SYSTEM');
      const legacy = path.join(home, '.agents-system');
      fs.symlinkSync(sysTarget, legacy, process.platform === 'win32' ? 'junction' : undefined);

      const plan = planUninstall();
      const res = executeUninstall(plan, { purge: false, timestamp: 8 });
      console.log(JSON.stringify({
        plannedLegacy: plan.legacySymlink,
        legacyRemoved: res.legacySymlinkRemoved,
        legacyGone: !fs.existsSync(legacy),
        errors: res.errors,
      }));
    `);
    expect(result.plannedLegacy).toContain('.agents-system');
    expect(result.legacyRemoved).toBe(true);
    expect(result.legacyGone).toBe(true);

    expect(result.errors).toEqual([]);
  });

  it('is idempotent — a second uninstall run is a safe no-op', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '1.0.0', 'MANAGED');
      backup('claude', 1700000000000, 'ORIGINAL_CLAUDE');
      const plan1 = planUninstall();
      executeUninstall(plan1, { purge: false, timestamp: 1 });

      const plan2 = planUninstall();
      const res2 = executeUninstall(plan2, { purge: false, timestamp: 2 });
      const claudePath = path.join(home, '.claude');
      console.log(JSON.stringify({
        secondIsInstalled: plan2.isInstalled,
        claudeContentIntact: fs.readFileSync(path.join(claudePath, 'marker'), 'utf-8'),
        secondErrors: res2.errors,
        secondRestored: res2.restoredConfigs.length,
      }));
    `);
    expect(result.secondIsInstalled).toBe(false);
    expect(result.claudeContentIntact).toBe('ORIGINAL_CLAUDE');
    expect(result.secondErrors).toEqual([]);
    expect(result.secondRestored).toBe(0);
  });

  it('planUninstall is read-only — a dry run mutates nothing', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '1.0.0', 'MANAGED');
      backup('claude', 1700000000000, 'ORIGINAL');
      const before = fs.lstatSync(path.join(home, '.claude')).isSymbolicLink();
      const plan = planUninstall();
      console.log(JSON.stringify({
        stillSymlink: fs.lstatSync(path.join(home, '.claude')).isSymbolicLink(),
        wasSymlink: before,
        agentsIntact: fs.existsSync(userDir),
        claudeToRestore: plan.configs.find(c => c.agent === 'claude').kind,
      }));
    `);
    expect(result.wasSymlink).toBe(true);
    expect(result.stillSymlink).toBe(true);
    expect(result.agentsIntact).toBe(true);
    expect(result.claudeToRestore).toBe('restore-backup');
  });
});
