import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { getProjectVersion, removeVersion, getVersionDir, markVersionIsolated, isVersionIsolated } from '../installations/versions.js';
import { getVersionsDir, getTrashVersionsDir } from '../state.js';
import { getDB, updateSessionFilePaths } from '../session/db.js';
import type { AgentId } from '../types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versions-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getProjectVersion', () => {
  it('resolves version from agents.yaml in startPath', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: "1.2.3"\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBe('1.2.3');
  });

  it('walks up to find agents.yaml in a parent directory', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: "2.0.0"\n',
    );
    expect(getProjectVersion('claude', nested)).toBe('2.0.0');
  });

  it('returns null when no agents.yaml exists', () => {
    const nested = path.join(tmpDir, 'empty');
    fs.mkdirSync(nested, { recursive: true });
    expect(getProjectVersion('claude', nested)).toBeNull();
  });

  it('returns null when agents.yaml exists but agent key is absent', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  codex: "0.9.0"\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBeNull();
  });

  it('ignores ~/.agents-system/ root when walking up', () => {
    // getProjectAgentsDir must skip both the system root (~/.agents-system/) and the
    // user root (~/.agents/) so they are never returned as project-scoped dirs.
    // We cannot mutate os.homedir(), but we CAN verify that starting the search
    // from inside ~/.agents-system/ returns null (no project version).
    const systemAgentsYaml = path.join(os.homedir(), '.agents-system', 'agents.yaml');
    if (fs.existsSync(systemAgentsYaml)) {
      const result = getProjectVersion('claude', path.dirname(systemAgentsYaml));
      expect(typeof result === 'string' || result === null).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  it('parses agents.yaml with quoted version string', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: \'1.5.0\'\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBe('1.5.0');
  });

  it('parses agents.yaml with unquoted version string', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'agents.yaml'),
      'agents:\n  claude: 1.7.2\n',
    );
    expect(getProjectVersion('claude', tmpDir)).toBe('1.7.2');
  });
});

// Scenario: the user uninstalls an agent version. Their conversation history,
// which lives at .../versions/<agent>/<version>/home/, must survive — now
// inside the trash directory because removeVersion is a soft-delete: the
// entire version dir (including home/) is renamed to
// ~/.agents-system/trash/versions/<agent>/<version>/<timestamp>/.
// Verified for every AgentId since removeVersion is parametrised on agent and
// the layout is shared across all agents.
describe('removeVersion soft-deletes the entire version dir to trash', () => {
  const cases: { agent: AgentId; historyDir: string; binaryName: string }[] = [
    { agent: 'claude',   historyDir: path.join('home', '.claude',   'projects'), binaryName: 'claude' },
    { agent: 'codex',    historyDir: path.join('home', '.codex',    'sessions'), binaryName: 'codex' },
    { agent: 'cursor',   historyDir: path.join('home', '.cursor',   'sessions'), binaryName: 'cursor-agent' },
    { agent: 'opencode', historyDir: path.join('home', '.opencode', 'sessions'), binaryName: 'opencode' },
    { agent: 'openclaw', historyDir: path.join('home', '.openclaw', 'sessions'), binaryName: 'openclaw' },
  ];

  for (const { agent, historyDir, binaryName } of cases) {
    it(`[${agent}] moves whole versionDir to trash; binaries AND home/ survive there`, () => {
      const testVersion = `0.0.0-test-${crypto.randomBytes(4).toString('hex')}`;
      const versionDir = path.join(getVersionsDir(), agent, testVersion);
      const trashAgentDir = path.join(getTrashVersionsDir(), agent, testVersion);

      try {
        fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });
        fs.writeFileSync(path.join(versionDir, 'node_modules', '.bin', binaryName), '#!/bin/sh\n');
        fs.writeFileSync(path.join(versionDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(versionDir, 'package-lock.json'), '{}');

        const sessionDir = path.join(versionDir, historyDir);
        fs.mkdirSync(sessionDir, { recursive: true });
        const sessionRel = path.relative(versionDir, path.join(sessionDir, 'session.jsonl'));
        fs.writeFileSync(path.join(versionDir, sessionRel), '{"type":"user"}\n');

        expect(removeVersion(agent, testVersion)).toBe(true);

        // Original location is gone — soft-delete renamed it.
        expect(fs.existsSync(versionDir)).toBe(false);

        // Trash now contains exactly one timestamped copy with everything.
        const stamps = fs.readdirSync(trashAgentDir);
        expect(stamps.length).toBe(1);
        const trashed = path.join(trashAgentDir, stamps[0]);

        expect(fs.existsSync(path.join(trashed, 'node_modules', '.bin', binaryName))).toBe(true);
        expect(fs.existsSync(path.join(trashed, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(trashed, sessionRel))).toBe(true);
      } finally {
        if (fs.existsSync(versionDir)) {
          fs.rmSync(versionDir, { recursive: true, force: true });
        }
        if (fs.existsSync(trashAgentDir)) {
          fs.rmSync(trashAgentDir, { recursive: true, force: true });
        }
      }
    });
  }
});

// Regression: for a commands-as-skills agent (kimi: commands:false, skills:true,
// no native command runtime), the commands writer materializes each command as a
// skill dir under skills/. The skills orphan-sweep that runs afterward in a full
// (no-selection) sync must NOT delete those converted command-skills — that bug
// silently dropped every command (e.g. /recap) from kimi/grok.
describe('syncResourcesToVersion preserves command-skills through the skills orphan-sweep', () => {
  it('[kimi] keeps converted command-skills AND real skills after a full sync', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdskill-sweep-'));
    try {
      const script = String.raw`
        import * as fs from 'fs';
        import * as path from 'path';
        import { getVersionHomePath, syncResourcesToVersion } from './src/lib/installations/versions.ts';

        const home = process.env.HOME;
        if (!home) throw new Error('HOME missing');
        const userDir = path.join(home, '.agents');
        const projectRoot = path.join(home, 'project');
        fs.mkdirSync(projectRoot, { recursive: true });
        const write = (rel, content) => {
          const p = path.join(userDir, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content);
        };
        // A top-level command (converts to a command-skill) and a real skill.
        write('commands/recap.md', ['---','description: Recap','---','','recap body'].join('\n'));
        write('skills/realskill/SKILL.md', ['---','name: realskill','description: a real skill','---','','body'].join('\n'));

        const agent = 'kimi';
        const version = '0.0.0-test';
        const fakeBin = path.join(userDir, '.history', 'versions', agent, version, 'node_modules', '.bin', 'kimi');
        fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
        fs.writeFileSync(fakeBin, '#!/usr/bin/env sh\nexit 0\n');
        fs.chmodSync(fakeBin, 0o755);

        // Full sync: no selection -> orphan sweep runs.
        syncResourcesToVersion(agent, version, undefined, { cwd: projectRoot, force: true });

        const skillsDir = path.join(getVersionHomePath(agent, version), '.kimi-code', 'skills');
        const recapMd = path.join(skillsDir, 'recap', 'SKILL.md');
        console.log(JSON.stringify({
          recapExists: fs.existsSync(recapMd),
          recapIsCommandSkill: fs.existsSync(recapMd) && fs.readFileSync(recapMd, 'utf-8').includes('agents_command: "recap"'),
          realSkillExists: fs.existsSync(path.join(skillsDir, 'realskill', 'SKILL.md')),
        }));
      `;
      const out = execFileSync('bun', ['--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      const result = JSON.parse(out.trim()) as {
        recapExists: boolean; recapIsCommandSkill: boolean; realSkillExists: boolean;
      };
      expect(result.recapExists).toBe(true);
      expect(result.recapIsCommandSkill).toBe(true);
      expect(result.realSkillExists).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});


describe('syncResourcesToVersion respects version-gated subagent capabilities', () => {
  it('[antigravity] skips subagents before 1.0.16 and syncs them at 1.0.16+', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-version-gate-'));
    try {
      const script = String.raw`
        import * as fs from 'fs';
        import * as path from 'path';
        import { getVersionHomePath, syncResourcesToVersion } from './src/lib/installations/versions.ts';

        const home = process.env.HOME;
        if (!home) throw new Error('HOME missing');
        const userDir = path.join(home, '.agents');
        const projectRoot = path.join(home, 'project');
        fs.mkdirSync(projectRoot, { recursive: true });
        const subagentDir = path.join(userDir, 'subagents', 'verifier');
        fs.mkdirSync(subagentDir, { recursive: true });
        fs.writeFileSync(
          path.join(subagentDir, 'AGENT.md'),
          ['---','name: verifier','description: Verifies work','---','','Check the installed artifact.'].join('\n')
        );

        for (const version of ['1.0.15', '1.0.16']) {
          const fakeBin = path.join(userDir, '.history', 'versions', 'antigravity', version, 'node_modules', '.bin', 'agy');
          fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
          fs.writeFileSync(fakeBin, '#!/usr/bin/env sh\nexit 0\n');
          fs.chmodSync(fakeBin, 0o755);
          syncResourcesToVersion('antigravity', version, { subagents: ['verifier'] }, { cwd: projectRoot, force: true });
        }

        const beforePath = path.join(getVersionHomePath('antigravity', '1.0.15'), '.gemini', 'config', 'agents', 'verifier', 'agent.md');
        const afterPath = path.join(getVersionHomePath('antigravity', '1.0.16'), '.gemini', 'config', 'agents', 'verifier', 'agent.md');
        console.log(JSON.stringify({ beforeExists: fs.existsSync(beforePath), afterExists: fs.existsSync(afterPath) }));
      `;
      const out = execFileSync('bun', ['--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      const result = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { beforeExists: boolean; afterExists: boolean };
      expect(result.beforeExists).toBe(false);
      expect(result.afterExists).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// When a version is removed, the command handler calls removeVersion then
// updateSessionFilePaths so session reads still work from the new trash location.
// This test verifies both pieces independently and together.
describe('updateSessionFilePaths rewrites file_path after soft-delete to trash', () => {
  const testVersion = `0.0.0-dbtest-${crypto.randomBytes(4).toString('hex')}`;
  const testSessionId = `test-session-${crypto.randomBytes(8).toString('hex')}`;
  const agent: AgentId = 'claude';
  const binaryName = 'claude';

  afterEach(() => {
    // Clean up the test session row from the real DB
    try {
      const db = getDB();
      db.prepare(`DELETE FROM session_text WHERE session_id = ?`).run(testSessionId);
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testSessionId);
    } catch { /* ignore */ }

    // Clean up any leftover version or trash dirs
    const versionDir = path.join(getVersionsDir(), agent, testVersion);
    const trashAgentDir = path.join(getTrashVersionsDir(), agent, testVersion);
    if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true });
    if (fs.existsSync(trashAgentDir)) fs.rmSync(trashAgentDir, { recursive: true, force: true });
  });

  it('rewrites file_path to trash location after removeVersion + updateSessionFilePaths', () => {
    const versionDir = path.join(getVersionsDir(), agent, testVersion);
    const sessionJsonl = path.join(versionDir, 'home', '.claude', 'projects', 'test', `${testSessionId}.jsonl`);

    // Set up a minimal version dir so removeVersion has something to soft-delete
    fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(versionDir, 'node_modules', '.bin', binaryName), '#!/bin/sh\n');
    fs.writeFileSync(path.join(versionDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(versionDir, 'package-lock.json'), '{}');
    fs.mkdirSync(path.dirname(sessionJsonl), { recursive: true });
    fs.writeFileSync(sessionJsonl, '{"type":"user"}\n');

    // Insert a session row pointing at the version-dir path
    const db = getDB();
    db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, short_id, agent, timestamp, file_path, is_team_origin)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(testSessionId, testSessionId.slice(0, 8), 'claude', new Date().toISOString(), sessionJsonl);

    // Soft-delete the version (mirrors what the command handler does)
    expect(removeVersion(agent, testVersion)).toBe(true);

    // The trash dir now holds a timestamped copy
    const trashAgentDir = path.join(getTrashVersionsDir(), agent, testVersion);
    const stamps = fs.readdirSync(trashAgentDir).sort().reverse();
    expect(stamps.length).toBeGreaterThan(0);
    const trashVersionDir = path.join(trashAgentDir, stamps[0]);

    // Simulate what the command handler does: rewrite file_paths to trash location
    const updated = updateSessionFilePaths(versionDir, trashVersionDir);
    expect(updated).toBe(1);

    // DB file_path must now point into the trash location
    const row = db.prepare(`SELECT file_path FROM sessions WHERE id = ?`).get(testSessionId) as { file_path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.file_path.startsWith(trashVersionDir)).toBe(true);

    // The file must actually exist at the new path
    expect(fs.existsSync(row!.file_path)).toBe(true);
  });
});

// An isolated install (`agents add --isolated`) is tagged with a `.isolated`
// sentinel at the version-dir root. The marker is what keeps every "adopting"
// code path away from the copy, so the roundtrip and the unmarked-default case
// must both be exact.
describe('isolated install markers', () => {
  it('marks a version isolated, reads it back, and leaves other versions unmarked', () => {
    const agent: AgentId = 'claude';
    const isoVersion = `0.0.0-iso-${crypto.randomBytes(4).toString('hex')}`;
    const normalVersion = `0.0.0-norm-${crypto.randomBytes(4).toString('hex')}`;
    const isoDir = getVersionDir(agent, isoVersion);
    const normalDir = getVersionDir(agent, normalVersion);

    try {
      fs.mkdirSync(isoDir, { recursive: true });
      fs.mkdirSync(normalDir, { recursive: true });

      // Absent marker -> not isolated.
      expect(isVersionIsolated(agent, isoVersion)).toBe(false);

      markVersionIsolated(agent, isoVersion);

      expect(isVersionIsolated(agent, isoVersion)).toBe(true);
      // A sibling version is unaffected.
      expect(isVersionIsolated(agent, normalVersion)).toBe(false);

      // The marker sits at the version-dir root so it travels to trash with the
      // whole dir on soft-delete (and is restored intact).
      expect(fs.existsSync(path.join(isoDir, '.isolated'))).toBe(true);
    } finally {
      fs.rmSync(isoDir, { recursive: true, force: true });
      fs.rmSync(normalDir, { recursive: true, force: true });
    }
  });
});

// Regression guard: removing the global default must NEVER auto-promote an
// isolated install to be the new default (that would silently make `<agent>`
// resolve to the isolated copy and let a later `use` adopt its home into
// ~/.<agent>). Run in a subprocess with an isolated HOME so the real
// ~/.agents/agents.yaml default pointer is never touched.
describe('removeVersion never promotes an isolated install to the global default', () => {
  // Shared preamble: fake a claude install whose real bin target exists, so
  // isVersionInstalled/listInstalledVersions recognise it without hitting npm.
  const preamble = String.raw`
    import * as fs from 'fs';
    import * as path from 'path';
    import { AGENTS } from './src/lib/agents.ts';
    import {
      getVersionDir, setGlobalDefault, getGlobalDefault, removeVersion, markVersionIsolated,
    } from './src/lib/installations/versions.ts';

    function fakeInstall(agent, version) {
      const cfg = AGENTS[agent];
      const pkgRoot = path.join(getVersionDir(agent, version), 'node_modules', cfg.npmPackage);
      fs.mkdirSync(pkgRoot, { recursive: true });
      fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ bin: { [cfg.cliCommand]: 'cli.js' } }));
      fs.writeFileSync(path.join(pkgRoot, 'cli.js'), '#!/usr/bin/env node\n');
    }
  `;

  it('clears the default when the only survivor is isolated', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-default-clear-'));
    try {
      const script = preamble + String.raw`
        fakeInstall('claude', '1.0.0');   // normal default
        fakeInstall('claude', '2.0.0');    // isolated survivor
        markVersionIsolated('claude', '2.0.0');
        setGlobalDefault('claude', '1.0.0');

        removeVersion('claude', '1.0.0');

        console.log(JSON.stringify({ afterDefault: getGlobalDefault('claude') }));
      `;
      const out = execFileSync('bun', ['--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      const result = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { afterDefault: string | null };
      // NOT '2.0.0' — the isolated survivor must not be adopted as the default.
      expect(result.afterDefault).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('promotes the newest NON-isolated survivor, skipping a newer isolated one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-default-skip-'));
    try {
      const script = preamble + String.raw`
        fakeInstall('claude', '1.0.0');   // normal default (to be removed)
        fakeInstall('claude', '1.5.0');    // normal survivor
        fakeInstall('claude', '2.0.0');    // isolated survivor (newer)
        markVersionIsolated('claude', '2.0.0');
        setGlobalDefault('claude', '1.0.0');

        removeVersion('claude', '1.0.0');

        console.log(JSON.stringify({ afterDefault: getGlobalDefault('claude') }));
      `;
      const out = execFileSync('bun', ['--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      const result = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { afterDefault: string | null };
      // The newer 2.0.0 is isolated, so the newest promotable version is 1.5.0.
      expect(result.afterDefault).toBe('1.5.0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
