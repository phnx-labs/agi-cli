/** RUSH-2438: `agents sync` was additive-only (repo-scoped reconciles turned off orphan sweeps).
 * Real sync path in an isolated `$HOME`. Source-removed resources ARE pruned; user files and
 * same-named resources in other layers are NOT; with no manifest, prune fails loud (no deletes). */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { PRUNABLE_KINDS } from './prune.js';
import { getWriter } from './registry.js';
import { MANAGED_AGENT_IDS } from '../agents.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Run `scriptBody` under a throwaway $HOME; returns the parsed last JSON line. */
function runInTempHome(scriptBody: string): Record<string, unknown> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-prune-'));
  try {
    const script = `
      import * as fs from 'fs';
      import * as path from 'path';
      import { syncResourcesToVersion, buildRepoScopedSelection } from './src/lib/installations/versions.ts';

      const home = process.env.HOME;
      if (!home) throw new Error('HOME missing');
      const userDir = path.join(home, '.agents');
      const systemDir = path.join(userDir, '.system');           // ~/.agents/.system
      const projectRoot = path.join(home, 'project');
      const version = '2.1.141';
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(path.join(systemDir, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });

      const writeSystemCmd = (name, body) => fs.writeFileSync(
        path.join(systemDir, 'commands', name + '.md'),
        ['---', 'description: ' + name, '---', '', body].join('\\n'),
      );
      const writeUserCmd = (name, body) => fs.writeFileSync(
        path.join(userDir, 'commands', name + '.md'),
        ['---', 'description: ' + name, '---', '', body].join('\\n'),
      );
      const cmdDir = path.join(userDir, '.history', 'versions', 'claude', version, 'home', '.claude', 'commands');
      const cmdFiles = () => (fs.existsSync(cmdDir) ? fs.readdirSync(cmdDir).sort() : []);
      const manifestPath = path.join(userDir, '.history', 'versions', 'claude', version, 'home', '.sync-manifest.json');

      const fullSync = () => syncResourcesToVersion('claude', version, undefined, { cwd: projectRoot, force: true });
      const scopedPrune = () => syncResourcesToVersion(
        'claude', version, buildRepoScopedSelection('system', projectRoot),
        { cwd: projectRoot, force: true, prune: true },
      );

      // Codex >= 0.117 installs commands as skill dirs under .codex/skills/ —
      // a distinct home layout the prune must handle via the command-skill inverse.
      const codexVersion = '0.130.0';
      const codexSkillsDir = path.join(userDir, '.history', 'versions', 'codex', codexVersion, 'home', '.codex', 'skills');
      const codexCmdSkills = () => (fs.existsSync(codexSkillsDir)
        ? fs.readdirSync(codexSkillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
        : []);
      const fullSyncCodex = () => syncResourcesToVersion('codex', codexVersion, undefined, { cwd: projectRoot, force: true });
      const scopedPruneCodex = () => syncResourcesToVersion(
        'codex', codexVersion, buildRepoScopedSelection('system', projectRoot),
        { cwd: projectRoot, force: true, prune: true },
      );

      // ---- skills (claude .claude/skills/<name>/) ----
      const writeSystemSkill = (name, body) => {
        const d = path.join(systemDir, 'skills', name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'SKILL.md'),
          ['---', 'name: ' + name, 'description: ' + name, '---', '', body].join('\\n'));
      };
      const skillDir = path.join(userDir, '.history', 'versions', 'claude', version, 'home', '.claude', 'skills');
      const skillDirs = () => (fs.existsSync(skillDir)
        ? fs.readdirSync(skillDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
        : []);

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

describe('agents sync prune (RUSH-2438)', () => {
  it('(a) prunes a command deleted from source on a repo-scoped reconcile', () => {
    const result = runInTempHome(`
      writeSystemCmd('alpha', 'alpha body');
      writeSystemCmd('beta', 'beta body');

      fullSync();                                     // installs both, writes manifest
      const beforeFiles = cmdFiles();
      const manifestExisted = fs.existsSync(manifestPath);

      fs.rmSync(path.join(systemDir, 'commands', 'beta.md'));   // remove from source
      const r = scopedPrune();

      console.log(JSON.stringify({
        manifestExisted,
        beforeFiles,
        afterFiles: cmdFiles(),
        prunedCommands: r.pruned.commands,
      }));
    `) as { manifestExisted: boolean; beforeFiles: string[]; afterFiles: string[]; prunedCommands: string[] };

    expect(result.manifestExisted).toBe(true);
    expect(result.beforeFiles).toEqual(['alpha.md', 'beta.md']);
    expect(result.prunedCommands).toEqual(['beta']);
    expect(result.afterFiles).toEqual(['alpha.md']);            // beta.md gone, alpha.md kept
  });

  it('(b) does NOT touch a user-authored file the sync never placed', () => {
    const result = runInTempHome(`
      writeSystemCmd('alpha', 'alpha body');
      fullSync();                                     // manifest records only 'alpha'

      // A file hand-dropped into the version home (via ~/.claude symlink) that
      // the sync never installed — never recorded in the manifest.
      fs.writeFileSync(path.join(cmdDir, 'mycustom.md'), '---\\ndescription: mine\\n---\\n\\nlocal only');

      const r = scopedPrune();
      console.log(JSON.stringify({ afterFiles: cmdFiles(), prunedCommands: r.pruned.commands }));
    `) as { afterFiles: string[]; prunedCommands: string[] };

    expect(result.prunedCommands).toEqual([]);                  // nothing pruned
    expect(result.afterFiles).toContain('mycustom.md');         // user file survives
    expect(result.afterFiles).toContain('alpha.md');
  });

  it('(c) does NOT cross-prune a same-named command still present in another layer', () => {
    const result = runInTempHome(`
      writeSystemCmd('alpha', 'alpha body');
      writeSystemCmd('shared', 'system shared');
      writeUserCmd('shared', 'user shared');          // same name, user layer

      fullSync();                                     // manifest records alpha + shared
      fs.rmSync(path.join(systemDir, 'commands', 'shared.md'));  // gone from SYSTEM only

      const r = scopedPrune();
      console.log(JSON.stringify({ afterFiles: cmdFiles(), prunedCommands: r.pruned.commands }));
    `) as { afterFiles: string[]; prunedCommands: string[] };

    expect(result.prunedCommands).toEqual([]);                  // shared still in user layer
    expect(result.afterFiles).toContain('shared.md');           // preserved
    expect(result.afterFiles).toContain('alpha.md');
  });

  it('(d) fails loud with no manifest — deletes nothing', () => {
    const result = runInTempHome(`
      writeSystemCmd('alpha', 'alpha body');
      // Simulate a version home populated by a prior install that left NO manifest.
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.writeFileSync(path.join(cmdDir, 'alpha.md'), 'stale alpha');
      fs.writeFileSync(path.join(cmdDir, 'beta.md'), 'stale beta');   // not in source

      const manifestBefore = fs.existsSync(manifestPath);
      const r = scopedPrune();                        // beta gone from source, but no manifest
      console.log(JSON.stringify({
        manifestBefore,
        afterFiles: cmdFiles(),
        prunedCommands: r.pruned.commands,
      }));
    `) as { manifestBefore: boolean; afterFiles: string[]; prunedCommands: string[] };

    expect(result.manifestBefore).toBe(false);                  // no baseline
    expect(result.prunedCommands).toEqual([]);                  // no guess-delete
    expect(result.afterFiles).toContain('beta.md');             // stale file left in place
  });

  it('(a-codex) prunes a source-removed command from Codex command-as-skill homes', () => {
    const result = runInTempHome(`
      writeSystemCmd('alpha', 'alpha body');
      writeSystemCmd('beta', 'beta body');

      fullSyncCodex();                                // installs both as skill dirs
      const beforeSkills = codexCmdSkills();

      fs.rmSync(path.join(systemDir, 'commands', 'beta.md'));
      const r = scopedPruneCodex();

      console.log(JSON.stringify({
        beforeSkills,
        afterSkills: codexCmdSkills(),
        prunedCommands: r.pruned.commands,
      }));
    `) as { beforeSkills: string[]; afterSkills: string[]; prunedCommands: string[] };

    expect(result.beforeSkills).toContain('alpha');
    expect(result.beforeSkills).toContain('beta');
    expect(result.prunedCommands).toEqual(['beta']);
    expect(result.afterSkills).toContain('alpha');
    expect(result.afterSkills).not.toContain('beta');           // command-skill dir gone
  });

  it('(skill) prunes a skill deleted from source on a repo-scoped reconcile', () => {
    const result = runInTempHome(`
      writeSystemSkill('alpha', 'alpha skill');
      writeSystemSkill('beta', 'beta skill');

      fullSync();                                     // installs both skill dirs + manifest
      const before = skillDirs();

      fs.rmSync(path.join(systemDir, 'skills', 'beta'), { recursive: true });
      const r = scopedPrune();

      console.log(JSON.stringify({ before, after: skillDirs(), prunedSkills: r.pruned.skills }));
    `) as { before: string[]; after: string[]; prunedSkills: string[] };

    expect(result.before).toEqual(['alpha', 'beta']);
    expect(result.prunedSkills).toEqual(['beta']);
    expect(result.after).toEqual(['alpha']);          // beta skill dir removed, alpha kept
  });

  it('(guard) a skill prune must NOT destroy a same-named command-skill', () => {
    // The guard at writers/skills.ts remove() skips a directory that is a command-skill
    // (agents_command marker). A name that was a skill but is now a command installed as a skill
    // must survive a skill prune, or a live command is destroyed.
    const result = runInTempHome(`
      writeSystemSkill('foo', 'foo skill');
      writeSystemSkill('keep', 'keep skill');
      fullSyncCodex();                                // manifest.skills = {foo, keep}

      // foo stops being a skill and becomes a command → installs as .codex/skills/foo (command-skill).
      fs.rmSync(path.join(systemDir, 'skills', 'foo'), { recursive: true });
      writeSystemCmd('foo', 'foo command body');

      const r = scopedPruneCodex();
      const fooSkillMd = path.join(codexSkillsDir, 'foo', 'SKILL.md');
      const fooStillPresent = fs.existsSync(fooSkillMd);
      const fooIsCommandSkill = fooStillPresent && fs.readFileSync(fooSkillMd, 'utf-8').includes('agents_command');
      console.log(JSON.stringify({
        skills: codexCmdSkills(),
        fooStillPresent,
        fooIsCommandSkill,
        prunedSkills: r.pruned.skills,
      }));
    `) as { skills: string[]; fooStillPresent: boolean; fooIsCommandSkill: boolean; prunedSkills: string[] };

    expect(result.prunedSkills).not.toContain('foo');  // skill prune left it alone
    expect(result.fooStillPresent).toBe(true);         // command-skill dir survives
    expect(result.fooIsCommandSkill).toBe(true);       // and is still the live command
  });

  it('every writer for a PRUNABLE_KIND implements remove() (harness parity)', () => {
    // The manifest-bounded prune only ever deletes through writer.remove(). If a
    // prunable kind's writer for some harness lacks it, that harness silently
    // never prunes — this pins parity across every registered writer.
    const missing: string[] = [];
    for (const kind of PRUNABLE_KINDS) {
      for (const agent of MANAGED_AGENT_IDS) {
        const writer = getWriter(kind, agent);
        if (writer && typeof writer.remove !== 'function') {
          missing.push(`${kind}/${agent}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
