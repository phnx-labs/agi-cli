import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function runInTempHome(scriptBody: string): Record<string, unknown> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-restore-'));
  try {
    const script = `
      import * as fs from 'fs';
      import * as path from 'path';
      import { syncResourcesToVersion } from './src/lib/installations/versions.ts';
      import { loadManifest, saveManifest, isStale } from './src/lib/staleness/index.ts';

      const home = process.env.HOME;
      if (!home) throw new Error('HOME missing');
      const userDir = path.join(home, '.agents');
      const projectRoot = path.join(home, 'project');
      const version = '2.1.141';
      const versionHome = path.join(userDir, '.history', 'versions', 'claude', version, 'home');
      fs.mkdirSync(projectRoot, { recursive: true });

      // Central sources: one subagent (the #2398 repro resource), one command,
      // one skill.
      fs.mkdirSync(path.join(userDir, 'subagents', 'code-reviewer'), { recursive: true });
      fs.writeFileSync(
        path.join(userDir, 'subagents', 'code-reviewer', 'AGENT.md'),
        ['---', 'name: code-reviewer', 'description: Reviews code', '---', '', 'review body'].join('\\n'),
      );
      fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(userDir, 'commands', 'plan.md'),
        ['---', 'description: Plan', '---', '', 'plan body'].join('\\n'),
      );
      fs.mkdirSync(path.join(userDir, 'skills', 'my-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(userDir, 'skills', 'my-skill', 'SKILL.md'),
        ['---', 'name: my-skill', 'description: A skill', '---', '', 'skill body'].join('\\n'),
      );

      const subagentFile = path.join(versionHome, '.claude', 'agents', 'code-reviewer.md');
      const commandFile  = path.join(versionHome, '.claude', 'commands', 'plan.md');
      const skillDir     = path.join(versionHome, '.claude', 'skills', 'my-skill');
      const fullSync = () => syncResourcesToVersion('claude', version, undefined, { cwd: projectRoot });
      const stale = () => {
        const m = loadManifest('claude', version);
        return m === null ? null : isStale(m, 'claude', version, projectRoot);
      };

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

describe('sync restores deleted version-home resources (#2398)', () => {
  it('a deleted subagent file reads as stale and a plain sync (no --force) restores it', () => {
    const result = runInTempHome(`
      fullSync();
      const wroteInitially = fs.existsSync(subagentFile);
      const staleAfterFullSync = stale();

      // The #2398 repro: delete the synced artifact from the version home.
      fs.unlinkSync(subagentFile);
      const staleAfterDelete = stale();

      // Ordinary recovery path — no selection, no --force.
      const r = fullSync();
      console.log(JSON.stringify({
        wroteInitially,
        staleAfterFullSync,
        staleAfterDelete,
        restored: fs.existsSync(subagentFile),
        resyncedSubagents: r.subagents,
        staleAfterRestore: stale(),
      }));
    `);
    expect(result.wroteInitially).toBe(true);
    expect(result.staleAfterFullSync).toBe(false);
    expect(result.staleAfterDelete).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.resyncedSubagents).toContain('code-reviewer');
    expect(result.staleAfterRestore).toBe(false);
  });

  it('a deleted command file and a deleted skill dir are likewise restored without --force', () => {
    const result = runInTempHome(`
      fullSync();
      fs.unlinkSync(commandFile);
      const staleAfterCommandDelete = stale();
      fullSync();
      const commandRestored = fs.existsSync(commandFile);

      fs.rmSync(skillDir, { recursive: true, force: true });
      const staleAfterSkillDelete = stale();
      fullSync();
      console.log(JSON.stringify({
        staleAfterCommandDelete,
        commandRestored,
        staleAfterSkillDelete,
        skillRestored: fs.existsSync(path.join(skillDir, 'SKILL.md')),
        staleAtEnd: stale(),
      }));
    `);
    expect(result.staleAfterCommandDelete).toBe(true);
    expect(result.commandRestored).toBe(true);
    expect(result.staleAfterSkillDelete).toBe(true);
    expect(result.skillRestored).toBe(true);
    expect(result.staleAtEnd).toBe(false);
  });

  it('an untouched home stays a guard-hit no-op, and a pre-upgrade manifest (no writtenTargets) forces exactly one re-sync', () => {
    const result = runInTempHome(`
      fullSync();
      // Guard hit: nothing changed, so the early return yields an all-empty result.
      const noop = fullSync();
      const noopWasGuardHit = !noop.commands && !noop.skills && noop.subagents.length === 0;

      // Simulate a manifest written by a pre-#2398 agents-cli.
      const m = loadManifest('claude', version);
      delete m.writtenTargets;
      saveManifest('claude', version, m);
      const staleWithoutField = stale();

      // The forced migration re-sync re-establishes the baseline.
      fullSync();
      const m2 = loadManifest('claude', version);
      console.log(JSON.stringify({
        noopWasGuardHit,
        staleWithoutField,
        baselineRecorded: Array.isArray(m2.writtenTargets) && m2.writtenTargets.length > 0,
        staleAfterMigration: stale(),
      }));
    `);
    expect(result.noopWasGuardHit).toBe(true);
    expect(result.staleWithoutField).toBe(true);
    expect(result.baselineRecorded).toBe(true);
    expect(result.staleAfterMigration).toBe(false);
  });
});
