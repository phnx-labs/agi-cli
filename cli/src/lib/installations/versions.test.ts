import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
// Pure — takes an explicit directory, no HOME-derived state — safe to call
// directly in this process. getBinaryPath itself is exercised through
// runVersionSync's isolated-HOME subprocess below, like every other
// versions.ts function whose paths derive from HOME.
import { resolveGrokFallbackBinary, resolveHookSelection } from './versions.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-versions-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function nodeExecPath(): string {
  if (!('bun' in process.versions)) return process.execPath;
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return binary;
}

function runVersionSync(home: string, expression: string): unknown {
  // tsx (Node) — not bun. The CLI ships against Node, and `versions.ts`
  // transitively imports the SQLite layer that this test exercises.
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { listInstalledVersions, syncResourcesToVersion, buildRepoScopedSelection, getVersionHomePath, getBinaryPath } from ${JSON.stringify(moduleUrl)};
    import { registerHooksToSettings } from ${JSON.stringify(pathToFileURL(path.resolve('src/lib/hooks/install.ts')).href)};
    const home = ${JSON.stringify(home)};
    const result = ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

function runReconcile(home: string, agent: string, installedVersion: string): string {
  // tsx (Node) subprocess with an isolated HOME — exercises the real fs +
  // session-db path that reconcileStaleLatestDir touches, no mocking.
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { reconcileStaleLatestDir } from ${JSON.stringify(moduleUrl)};
    (async () => {
      const result = await reconcileStaleLatestDir(${JSON.stringify(agent)}, ${JSON.stringify(installedVersion)});
      console.log(JSON.stringify(result));
    })();
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

function droidVersionDir(home: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', 'droid', version);
}

describe('reconcileStaleLatestDir', () => {
  it('renames a stale literal `latest` dir onto the resolved version, preserving home/', () => {
    const home = makeTempHome();
    const latestHome = path.join(droidVersionDir(home, 'latest'), 'home');
    fs.mkdirSync(latestHome, { recursive: true });
    fs.writeFileSync(path.join(latestHome, 'marker.txt'), 'keep me', 'utf-8');

    const action = runReconcile(home, 'droid', '0.158.0');

    expect(action).toBe('renamed');
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
    expect(fs.readFileSync(path.join(droidVersionDir(home, '0.158.0'), 'home', 'marker.txt'), 'utf-8')).toBe('keep me');
  });

  it('trashes the stale `latest` dir when the resolved version dir already exists', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, 'latest'), 'home'), { recursive: true });
    fs.mkdirSync(path.join(droidVersionDir(home, '0.158.0'), 'home'), { recursive: true });

    const action = runReconcile(home, 'droid', '0.158.0');

    expect(action).toBe('trashed');
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
    expect(fs.existsSync(droidVersionDir(home, '0.158.0'))).toBe(true);
    // Soft-deleted, not hard-deleted — recoverable from trash.
    const trashDir = path.join(home, '.agents', '.history', 'trash', 'versions', 'droid', 'latest');
    expect(fs.existsSync(trashDir)).toBe(true);
  });

  it('is a no-op when no stale `latest` dir exists', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, '0.158.0'), 'home'), { recursive: true });

    const action = runReconcile(home, 'droid', '0.158.0');

    expect(action).toBe('none');
    expect(fs.existsSync(droidVersionDir(home, '0.158.0'))).toBe(true);
  });

  it('is a no-op when the resolved version is itself `latest` (probe failed)', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, 'latest'), 'home'), { recursive: true });

    const action = runReconcile(home, 'droid', 'latest');

    expect(action).toBe('none');
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(true);
  });
});

// Full path (RUSH-1320): resolve the live CLI version via a real `--version`
// shell-out, then fold the stale `latest` dir onto it. Uses a fake `droid` on
// PATH — no mocking — so getCliVersionFromPath returns a concrete version.
function runReconcileForAgent(home: string, agent: string, fakeBinDir: string): void {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { reconcileStaleLatestForAgent } from ${JSON.stringify(moduleUrl)};
    (async () => { await reconcileStaleLatestForAgent(${JSON.stringify(agent)}); })();
  `], {
    // Prepend the fake-bin dir so `droid --version` resolves to our stub.
    env: { ...process.env, HOME: home, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
}

describe('reconcileStaleLatestForAgent (proactive)', () => {
  it.skipIf(process.platform === 'win32')('folds a stale `latest` onto the live CLI version, preserving home/', () => {
    const home = makeTempHome();
    // Stale latest home with a credential-like file that must survive the fold.
    const latestFactory = path.join(droidVersionDir(home, 'latest'), 'home', '.factory');
    fs.mkdirSync(latestFactory, { recursive: true });
    fs.writeFileSync(path.join(latestFactory, 'auth.v2.file'), 'LOGIN');

    // Fake `droid --version` -> 0.161.0.
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const droidStub = path.join(binDir, 'droid');
    fs.writeFileSync(droidStub, '#!/bin/sh\necho "droid 0.161.0"\n');
    fs.chmodSync(droidStub, 0o755);

    runReconcileForAgent(home, 'droid', binDir);

    // `latest` is gone; its home (incl. the login file) now lives under 0.161.0.
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
    expect(fs.readFileSync(path.join(droidVersionDir(home, '0.161.0'), 'home', '.factory', 'auth.v2.file'), 'utf8')).toBe('LOGIN');
  });

  it.skipIf(process.platform === 'win32')('is a no-op when there is no stale `latest` dir', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, '0.161.0'), 'home'), { recursive: true });
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const droidStub = path.join(binDir, 'droid');
    fs.writeFileSync(droidStub, '#!/bin/sh\necho "droid 0.161.0"\n');
    fs.chmodSync(droidStub, 0o755);

    runReconcileForAgent(home, 'droid', binDir);

    // 0.161.0 untouched, no `latest` created.
    expect(fs.existsSync(droidVersionDir(home, '0.161.0'))).toBe(true);
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
  });
});

// RUSH-1321: a self-updating agent (droid) is ONE global binary. Its per-version
// dirs all map to the same executable, so agents-cli must model it as a single
// install — not a set of fictional version-homes. grok is self-updating too but
// stores a real per-version binary copy under each version-home, so it must NOT
// be collapsed.
function droidBin(home: string): string {
  return path.join(home, '.local', 'bin', 'droid');
}

function makeDroidBinary(home: string): void {
  const binDir = path.dirname(droidBin(home));
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(droidBin(home), '#!/bin/sh\necho "droid 0.21.0"\n');
  fs.chmodSync(droidBin(home), 0o755);
}

function grokBinaryDir(home: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', 'grok', version, 'home', '.grok', 'downloads');
}

// Predicate check runs in a tsx subprocess (versions.ts pulls in the SQLite
// layer with a top-level await the CJS test process can't statically transform).
function runPredicates(expression: string): unknown {
  const versionsUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  const agentsUrl = pathToFileURL(path.resolve('src/lib/agents.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { isGlobalBinaryAgent } from ${JSON.stringify(versionsUrl)};
    import { isSelfUpdatingAgent } from ${JSON.stringify(agentsUrl)};
    console.log(JSON.stringify(${expression}));
  `], { env: { ...process.env }, encoding: 'utf-8' });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('self-updating single-binary agents (RUSH-1321)', () => {
  it('classifies self-updating vs npm-packaged vs per-version-binary agents', () => {
    const r = runPredicates(`{
      droidSelf: isSelfUpdatingAgent('droid'),
      grokSelf: isSelfUpdatingAgent('grok'),
      antigravitySelf: isSelfUpdatingAgent('antigravity'),
      claudeSelf: isSelfUpdatingAgent('claude'),
      kimiSelf: isSelfUpdatingAgent('kimi'),
      droidGlobal: isGlobalBinaryAgent('droid'),
      grokGlobal: isGlobalBinaryAgent('grok'),
      claudeGlobal: isGlobalBinaryAgent('claude'),
    }`) as Record<string, boolean>;
    expect(r).toEqual({
      droidSelf: true,
      grokSelf: true,
      antigravitySelf: true,
      claudeSelf: false, // npm-packaged — pinnable, genuinely multi-version
      kimiSelf: false,   // npm-packaged
      droidGlobal: true, // one binary at ~/.local/bin/droid regardless of version
      grokGlobal: false, // per-version binary copy under each version-home
      claudeGlobal: false,
    });
  });

  it.skipIf(process.platform === 'win32')('collapses multiple droid version dirs to a single canonical entry', () => {
    const home = makeTempHome();
    makeDroidBinary(home);
    // Two real semver dirs that both resolve to the ONE global binary.
    fs.mkdirSync(path.join(droidVersionDir(home, '0.19.3'), 'home'), { recursive: true });
    fs.mkdirSync(path.join(droidVersionDir(home, '0.21.0'), 'home'), { recursive: true });

    const versions = runVersionSync(home, "listInstalledVersions('droid')") as string[];

    // One entry, not two phantom rows. Newest wins with no symlink/default/live cache.
    expect(versions).toEqual(['0.21.0']);
  });

  it.skipIf(process.platform === 'win32')('does NOT collapse grok — per-version-home binaries stay distinct', () => {
    const home = makeTempHome();
    for (const v of ['0.2.33', '0.2.40']) {
      const dir = grokBinaryDir(home, v);
      fs.mkdirSync(dir, { recursive: true });
      const bin = path.join(dir, `grok-${v}-test`);
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(bin, 0o755);
    }

    const versions = runVersionSync(home, "listInstalledVersions('grok')") as string[];

    expect(versions).toEqual(['0.2.33', '0.2.40']);
  });

  it.skipIf(process.platform === 'win32')('reconcile folds every stale droid dir into the live version, preserving home/', () => {
    const home = makeTempHome();
    // Two coexisting real-semver droid dirs; the old one carries a login file.
    const oldFactory = path.join(droidVersionDir(home, '0.19.3'), 'home', '.factory');
    fs.mkdirSync(oldFactory, { recursive: true });
    fs.writeFileSync(path.join(oldFactory, 'auth.v2.file'), 'LOGIN');
    fs.mkdirSync(path.join(droidVersionDir(home, '0.21.0'), 'home'), { recursive: true });

    // Fake `droid --version` -> 0.21.0 so the live version is the survivor.
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const droidStub = path.join(binDir, 'droid');
    fs.writeFileSync(droidStub, '#!/bin/sh\necho "droid 0.21.0"\n');
    fs.chmodSync(droidStub, 0o755);

    runReconcileForAgent(home, 'droid', binDir);

    // The stale 0.19.3 dir is folded away; only the live 0.21.0 survives on disk.
    expect(fs.existsSync(droidVersionDir(home, '0.19.3'))).toBe(false);
    expect(fs.existsSync(droidVersionDir(home, '0.21.0'))).toBe(true);
    // Soft-deleted (recoverable), not hard-deleted — its home/ (incl. login) is in trash.
    const trashDir = path.join(home, '.agents', '.history', 'trash', 'versions', 'droid', '0.19.3');
    expect(fs.existsSync(trashDir)).toBe(true);
  });
});

describe('version resource sync path handling', () => {
  it('keeps the generated OpenCode hooks plugin during an unrelated scoped sync', () => {
    const home = makeTempHome();
    const hooksDir = path.join(home, '.agents', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'keep.sh'), '#!/bin/sh\nexit 0\n', 'utf-8');
    fs.chmodSync(path.join(hooksDir, 'keep.sh'), 0o755);

    runVersionSync(
      home,
      `(() => {
        const versionHome = getVersionHomePath('opencode', '1.18.4');
        registerHooksToSettings(
          'opencode',
          versionHome,
          { keep: { script: 'keep.sh', events: ['SessionStart'] } },
          ${JSON.stringify(path.join(home, '.agents'))}
        );
        return syncResourcesToVersion(
          'opencode',
          '1.18.4',
          { commands: [] },
          { cwd: home }
        );
      })()`
    );

    expect(fs.existsSync(path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'opencode',
      '1.18.4',
      'home',
      '.config',
      'opencode',
      'plugins',
      'agents-cli-hooks.ts'
    ))).toBe(true);
  });

  it('intersects explicit resource selections with discovered resources before syncing', async () => {
    const home = makeTempHome();

    fs.mkdirSync(path.join(home, '.agents', '.system', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', '.system', 'commands', 'safe.md'), 'safe command', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', { commands: ['../escape', 'safe'] }, { cwd: home })"
    ) as { commands: boolean };

    expect(result.commands).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home', '.codex', 'prompts', 'safe.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home', '.codex', 'escape.md'))).toBe(false);
  });

  it('keeps prompts for Codex 0.116.x and converts commands to generated skills for Codex 0.117.0+', async () => {
    const home = makeTempHome();

    fs.mkdirSync(path.join(home, '.agents', '.system', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents', '.system', 'commands', 'recap.md'),
      ['---', 'description: Summarize the current session', '---', '', 'Recap the conversation so far.'].join('\n'),
      'utf-8'
    );

    const legacyResult = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.116.0', { commands: ['recap'] }, { cwd: home })"
    ) as { commands: boolean };
    const legacyVersionHome = path.join(home, '.agents', '.history', 'versions', 'codex', '0.116.0', 'home', '.codex');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.117.0', { commands: ['recap'] }, { cwd: home })"
    ) as { commands: boolean };

    const versionHome = path.join(home, '.agents', '.history', 'versions', 'codex', '0.117.0', 'home', '.codex');
    const skillPath = path.join(versionHome, 'skills', 'recap', 'SKILL.md');
    const skill = fs.readFileSync(skillPath, 'utf-8');

    expect(legacyResult.commands).toBe(true);
    expect(fs.existsSync(path.join(legacyVersionHome, 'prompts', 'recap.md'))).toBe(true);
    expect(fs.existsSync(path.join(legacyVersionHome, 'skills', 'recap', 'SKILL.md'))).toBe(false);
    expect(result.commands).toBe(true);
    expect(fs.existsSync(path.join(versionHome, 'prompts', 'recap.md'))).toBe(false);
    expect(skill).toContain('name: "recap"');
    expect(skill).toContain('agents_command: "recap"');
    expect(skill).toContain('When invoked with `$recap`');
    expect(skill).toContain('Recap the conversation so far.');
  });

  it('removes a stale legacy prompts/ file left by an older Codex version', () => {
    // The sibling test above only asserts the *current* command is absent from
    // prompts/, which the writer never puts there anyway — so it cannot catch a
    // regression in the legacy-dir cleanup. Pre-seed a file no sync will write.
    const home = makeTempHome();
    const sourceCommand = path.join(home, '.agents', '.system', 'commands', 'recap.md');
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'codex', '0.117.0', 'home', '.codex');
    const stale = path.join(versionHome, 'prompts', 'alpha.md');

    fs.mkdirSync(path.dirname(sourceCommand), { recursive: true });
    fs.writeFileSync(
      sourceCommand,
      ['---', 'description: Summarize the current session', '---', '', 'Recap the conversation so far.'].join('\n'),
      'utf-8'
    );
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'STALE ALPHA FROM CODEX 0.116', 'utf-8');

    runVersionSync(home, "syncResourcesToVersion('codex', '0.117.0', undefined, { force: true })");

    // Codex >= 0.117.0 converts commands to skills, so nothing may linger in
    // prompts/ — the orphan sweep is gated off for those agents and `agents
    // prune` only sees their skills, so a survivor is permanent.
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(versionHome, 'skills', 'recap', 'SKILL.md'))).toBe(true);
  });

  it('preserves user-authored Cursor IDE commands and syncs managed commands to both Cursor surfaces', () => {
    const home = makeTempHome();
    const projectRoot = path.join(home, 'repo');
    const projectCommand = path.join(projectRoot, '.agents', 'commands', 'projonly.md');
    const sourceCommand = path.join(home, '.agents', '.system', 'commands', 'recap.md');
    const cursorHome = path.join(home, '.agents', '.history', 'versions', 'cursor', '2026.07.23-e383d2b', 'home', '.cursor');
    const sentinel = path.join(cursorHome, 'commands', 'my-ide-command.md');
    const projectNameCollision = path.join(cursorHome, 'commands', 'projonly.md');

    fs.mkdirSync(path.dirname(projectCommand), { recursive: true });
    fs.writeFileSync(projectCommand, 'project-only command', 'utf-8');
    fs.mkdirSync(path.dirname(sourceCommand), { recursive: true });
    fs.writeFileSync(
      sourceCommand,
      ['---', 'description: Summarize the current session', '---', '', 'Recap the conversation so far.'].join('\n'),
      'utf-8'
    );
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'user-authored IDE command', 'utf-8');
    fs.writeFileSync(projectNameCollision, 'user-authored command matching a project command', 'utf-8');

    const first = runVersionSync(
      home,
      `syncResourcesToVersion('cursor', '2026.07.23-e383d2b', undefined, { cwd: ${JSON.stringify(projectRoot)}, force: true })`
    ) as { commands: boolean };
    const second = runVersionSync(
      home,
      `syncResourcesToVersion('cursor', '2026.07.23-e383d2b', undefined, { cwd: ${JSON.stringify(projectRoot)}, force: true })`
    ) as { commands: boolean };

    expect(first.commands).toBe(true);
    expect(second.commands).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf-8')).toBe('user-authored IDE command');
    expect(fs.readFileSync(projectNameCollision, 'utf-8')).toBe('user-authored command matching a project command');
    expect(fs.readFileSync(path.join(cursorHome, 'commands', 'recap.md'), 'utf-8')).toContain('Recap the conversation so far.');
    expect(fs.readFileSync(path.join(cursorHome, 'skills', 'recap', 'SKILL.md'), 'utf-8')).toContain('agents_command: "recap"');
  });

  it('syncs grok commands and skills to separate native paths', async () => {
    const home = makeTempHome();
    const commandPath = path.join(home, '.agents', 'commands', 'debug.md');
    const sourceSkillPath = path.join(home, '.agents', 'skills', 'debug', 'SKILL.md');
    const binaryPath = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'downloads', 'grok-0.2.33-macos-aarch64');

    fs.mkdirSync(path.dirname(commandPath), { recursive: true });
    fs.mkdirSync(path.dirname(sourceSkillPath), { recursive: true });
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(
      commandPath,
      ['---', 'description: Fresh debug command', '---', '', 'fresh command body'].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      sourceSkillPath,
      ['---', 'name: "debug"', 'description: "debug skill"', '---', '', 'skill body'].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', 'utf-8');
    fs.chmodSync(binaryPath, 0o755);

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('grok', '0.2.33', { commands: ['debug'], skills: ['debug'] }, { cwd: home })"
    ) as { commands: boolean; skills: boolean };

    const syncedCommandPath = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.agents', 'commands', 'debug.md');
    const syncedSkillPath = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'skills', 'debug', 'SKILL.md');
    expect(result.commands).toBe(true);
    expect(result.skills).toBe(true);
    expect(fs.existsSync(syncedCommandPath)).toBe(true);
    expect(fs.readFileSync(syncedCommandPath, 'utf-8')).toContain('fresh command body');
    expect(fs.existsSync(syncedSkillPath)).toBe(true);
    expect(fs.readFileSync(syncedSkillPath, 'utf-8')).toContain('skill body');
    expect(fs.existsSync(binaryPath)).toBe(true);
  });

  it('does not follow symlinks inside copied skill resources', async () => {
    const home = makeTempHome();

    const skillDir = path.join(home, '.agents', '.system', 'skills', 'leaky');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill body', 'utf-8');
    const secretPath = path.join(home, 'secret.txt');
    fs.writeFileSync(secretPath, 'secret', 'utf-8');
    fs.symlinkSync(secretPath, path.join(skillDir, 'secret-link'));

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', { skills: ['leaky'] }, { cwd: home })"
    ) as { skills: boolean };

    const syncedSkillDir = path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home', '.codex', 'skills', 'leaky');
    expect(result.skills).toBe(true);
    expect(fs.existsSync(path.join(syncedSkillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(syncedSkillDir, 'secret-link'))).toBe(false);
  });

  it('syncs hook directories through resource discovery', async () => {
    const home = makeTempHome();

    const hookDir = path.join(home, '.agents', 'hooks', 'tests');
    fs.mkdirSync(path.join(hookDir, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'fixtures', 'input.json'), '{"ok":true}\n', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('claude', '2.1.143', undefined, { cwd: home })"
    ) as { hooks: boolean };

    const copied = path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.143', 'home', '.claude', 'hooks', 'tests', 'fixtures', 'input.json');
    expect(result.hooks).toBe(true);
    expect(fs.readFileSync(copied, 'utf-8')).toBe('{"ok":true}\n');
    const settings = JSON.parse(fs.readFileSync(
      path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.143', 'home', '.claude', 'settings.json'),
      'utf-8',
    ));
    expect(settings.statusLine).toMatchObject({
      type: 'command',
      command: 'agents __claude-statusline',
    });

    const second = runVersionSync(
      home,
      "syncResourcesToVersion('claude', '2.1.143', undefined, { cwd: home })"
    ) as { hooks: boolean };
    expect(second.hooks).toBe(false);
  });

  it('skips a clean full sync after expanding persisted resource patterns', async () => {
    const home = makeTempHome();

    const skillDir = path.join(home, '.agents', '.system', 'skills', 'tiny');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill body', 'utf-8');

    const first = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', undefined, { cwd: home })"
    ) as { skills: boolean };

    const second = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', undefined, { cwd: home })"
    ) as { skills: boolean };

    expect(first.skills).toBe(true);
    expect(second.skills).toBe(false);
  });

  it('sweeps a flattened plugin skill out of a Claude home and keeps only the marketplace copy', async () => {
    const home = makeTempHome();
    const pluginRoot = path.join(home, '.agents', 'plugins', 'agents');
    const pluginSkillDir = path.join(pluginRoot, 'skills', 'routines');
    const versionSkillRoot = path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.65', 'home', '.claude', 'skills');

    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'agents', version: '1.0.0', description: 'Fixture plugin' }),
      'utf-8'
    );
    fs.mkdirSync(pluginSkillDir, { recursive: true });
    fs.writeFileSync(path.join(pluginSkillDir, 'SKILL.md'), 'fresh continuous ticket drain recipe\n', 'utf-8');
    fs.mkdirSync(path.join(versionSkillRoot, 'routines'), { recursive: true });
    fs.writeFileSync(path.join(versionSkillRoot, 'routines', 'SKILL.md'), 'stale routines body\n', 'utf-8');
    fs.mkdirSync(path.join(versionSkillRoot, 'old-shadow'), { recursive: true });
    fs.writeFileSync(path.join(versionSkillRoot, 'old-shadow', 'SKILL.md'), 'orphaned body\n', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('claude', '2.0.65', undefined, { cwd: home, force: true })"
    ) as { skills: boolean; plugins: string[] };

    const marketplaceSkill = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'claude',
      '2.0.65',
      'home',
      '.claude',
      'plugins',
      'marketplaces',
      'agents-cli',
      'plugins',
      'agents',
      'skills',
      'routines',
      'SKILL.md'
    );

    // Claude Code loads `agents:routines` from the marketplace copy itself; a
    // flattened skills/routines would be a second, un-namespaced `/routines`.
    expect(result.skills).toBe(false);
    expect(result.plugins).toEqual(['agents']);
    expect(fs.existsSync(path.join(versionSkillRoot, 'routines'))).toBe(false);
    expect(fs.existsSync(path.join(versionSkillRoot, 'old-shadow'))).toBe(false);
    expect(fs.existsSync(marketplaceSkill)).toBe(true);
  });

  it('still force-refreshes plugin-only skills into the top-level skill home of a flattening harness', async () => {
    const home = makeTempHome();
    const pluginRoot = path.join(home, '.agents', 'plugins', 'agents');
    const pluginSkillDir = path.join(pluginRoot, 'skills', 'routines');
    const versionSkillRoot = path.join(home, '.agents', '.history', 'versions', 'codex', '0.150.0', 'home', '.codex', 'skills');

    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'agents', version: '1.0.0', description: 'Fixture plugin' }),
      'utf-8'
    );
    fs.mkdirSync(pluginSkillDir, { recursive: true });
    fs.writeFileSync(path.join(pluginSkillDir, 'SKILL.md'), 'fresh continuous ticket drain recipe\n', 'utf-8');
    fs.mkdirSync(path.join(versionSkillRoot, 'routines'), { recursive: true });
    fs.writeFileSync(path.join(versionSkillRoot, 'routines', 'SKILL.md'), 'stale routines body\n', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.150.0', undefined, { cwd: home, force: true })"
    ) as { skills: boolean; plugins: string[] };

    const refreshed = fs.readFileSync(path.join(versionSkillRoot, 'routines', 'SKILL.md'), 'utf-8');
    expect(result.skills).toBe(true);
    expect(result.plugins).toEqual(['agents']);
    expect(refreshed).toContain('fresh continuous ticket drain recipe');
    expect(refreshed).not.toContain('stale routines body');
  });

  it('filters plugin-bundled skills through the active resource profile', () => {
    const home = makeTempHome();
    const makePluginSkill = (plugin: string, skill: string): void => {
      const pluginRoot = path.join(home, '.agents', 'plugins', plugin);
      fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: plugin, version: '1.0.0', description: 'Fixture plugin' }),
        'utf-8'
      );
      fs.mkdirSync(path.join(pluginRoot, 'skills', skill), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, 'skills', skill, 'SKILL.md'), `${skill} body\n`, 'utf-8');
    };

    makePluginSkill('agents', 'routines');
    makePluginSkill('agents', 'debug');
    makePluginSkill('blocked', 'secret');

    const versionsUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const profilesUrl = pathToFileURL(path.resolve('src/lib/resource-profiles.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import { getAvailableResources } from ${JSON.stringify(versionsUrl)};
      import { setActiveResourceProfile, upsertResourceProfilePreset } from ${JSON.stringify(profilesUrl)};
      const home = ${JSON.stringify(home)};
      upsertResourceProfilePreset('work', { plugins: ['agents'], skills: ['*', '!debug'] });
      setActiveResourceProfile('work');
      console.log(JSON.stringify(getAvailableResources(home)));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim()) as { plugins: string[]; skills: string[] };
    expect(result.plugins).toEqual(['agents']);
    expect(result.skills).toEqual(['routines']);
  });

  it('filters plugin-bundled skills through source-qualified resource profile selectors', () => {
    const home = makeTempHome();
    const pluginRoot = path.join(home, '.agents', 'plugins', 'agents');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'agents', version: '1.0.0', description: 'Fixture plugin' }),
      'utf-8'
    );
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'routines'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'skills', 'routines', 'SKILL.md'), 'routines body\n', 'utf-8');

    const versionsUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const profilesUrl = pathToFileURL(path.resolve('src/lib/resource-profiles.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import { getAvailableResources } from ${JSON.stringify(versionsUrl)};
      import { setActiveResourceProfile, upsertResourceProfilePreset } from ${JSON.stringify(profilesUrl)};
      upsertResourceProfilePreset('work', { plugins: ['agents'], skills: ['user:routines'] });
      setActiveResourceProfile('work');
      console.log(JSON.stringify(getAvailableResources(${JSON.stringify(home)})));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim()) as { plugins: string[]; skills: string[] };
    expect(result.plugins).toEqual(['agents']);
    expect(result.skills).toEqual(['routines']);
  });

  it('attributes permission groups and workflows to their real layers under resource profiles', () => {
    const home = makeTempHome();
    const project = path.join(home, 'repo');

    const writePermissionGroup = (base: string, name: string): void => {
      const dir = path.join(base, 'permissions', 'groups');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.yaml`), 'allow: []\ndeny: []\n', 'utf-8');
    };
    const writeWorkflow = (base: string, name: string): void => {
      const dir = path.join(base, 'workflows', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '---\ndescription: fixture\n---\nRun fixture.\n', 'utf-8');
    };

    const projectAgents = path.join(project, '.agents');
    const userAgents = path.join(home, '.agents');
    const systemAgents = path.join(home, '.agents', '.system');

    writePermissionGroup(projectAgents, 'project-perm');
    writePermissionGroup(userAgents, 'user-perm');
    writePermissionGroup(systemAgents, 'system-perm');
    writeWorkflow(projectAgents, 'project-flow');
    writeWorkflow(userAgents, 'user-flow');
    writeWorkflow(systemAgents, 'system-flow');

    const versionsUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const profilesUrl = pathToFileURL(path.resolve('src/lib/resource-profiles.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import { getAvailableResources } from ${JSON.stringify(versionsUrl)};
      import { setActiveResourceProfile, upsertResourceProfilePreset } from ${JSON.stringify(profilesUrl)};
      const project = ${JSON.stringify(project)};

      upsertResourceProfilePreset('exact', {
        permissions: ['project:project-perm', 'user:user-perm', 'system:system-perm'],
        workflows: ['project:project-flow', 'user:user-flow', 'system:system-flow'],
      });
      setActiveResourceProfile('exact');
      const exact = getAvailableResources(project);

      upsertResourceProfilePreset('wildcard', {
        permissions: ['system:*'],
        workflows: ['user:*'],
      });
      setActiveResourceProfile('wildcard');
      const wildcard = getAvailableResources(project);

      console.log(JSON.stringify({ exact, wildcard }));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim()) as {
      exact: { permissions: string[]; workflows: string[] };
      wildcard: { permissions: string[]; workflows: string[] };
    };
    expect(result.exact.permissions).toEqual(['project-perm', 'user-perm', 'system-perm']);
    expect(result.exact.workflows).toEqual(['project-flow', 'user-flow', 'system-flow']);
    expect(result.wildcard.permissions).toEqual(['system-perm']);
    expect(result.wildcard.workflows).toEqual(['user-flow']);
  });

  it('syncs project commands and skills to the project dot-agent dir, not the version home', () => {
    const home = makeTempHome();
    const project = path.join(home, 'repo');
    fs.mkdirSync(path.join(project, '.agents', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(project, '.agents', 'skills', 'local-skill'), { recursive: true });
    fs.writeFileSync(path.join(project, '.agents', 'commands', 'local.md'), 'Project command.', 'utf-8');
    fs.writeFileSync(path.join(project, '.agents', 'skills', 'local-skill', 'SKILL.md'), 'Project skill.', 'utf-8');

    runVersionSync(
      home,
      `syncResourcesToVersion('claude', '2.1.143', undefined, { cwd: ${JSON.stringify(project)} })`
    );

    const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.143', 'home', '.claude');
    expect(fs.existsSync(path.join(versionHome, 'commands', 'local.md'))).toBe(false);
    expect(fs.existsSync(path.join(versionHome, 'skills', 'local-skill'))).toBe(false);
    expect(fs.readFileSync(path.join(project, '.claude', 'commands', 'local.md'), 'utf-8')).toBe('Project command.');
    expect(fs.readFileSync(path.join(project, '.claude', 'skills', 'local-skill', 'SKILL.md'), 'utf-8')).toBe('Project skill.');
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.claude', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    expect(manifest.paths.sort()).toEqual(['commands/local.md', 'skills/local-skill'].sort());
  });

  it('writes missing grok AGENTS.md when syncing a partial selection without memory', async () => {
    const home = makeTempHome();
    const rulesDir = path.join(home, '.agents', '.system', 'rules');

    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'rules.yaml'),
      'presets:\n  default:\n    subrules:\n      - core\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), 'Grok memory body\n', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('grok', '0.2.33', { skills: [] }, { cwd: home })"
    ) as { memory: string[] };

    const agentsPath = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'AGENTS.md');
    expect(result.memory).toContain('AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);
    expect(fs.readFileSync(agentsPath, 'utf-8')).toContain('Grok memory body');
  });

  it('detects grok binaries from the per-version home, not the host .grok symlink', async () => {
    const home = makeTempHome();
    const installedDownloads = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'downloads');
    const emptyConfigDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.32', 'home', '.grok');
    const hostGrok = path.join(home, '.grok');

    fs.mkdirSync(installedDownloads, { recursive: true });
    fs.mkdirSync(path.join(emptyConfigDir, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(installedDownloads, 'grok-0.2.33-macos-aarch64'), '#!/bin/sh\nexit 0\n', 'utf-8');
    fs.chmodSync(path.join(installedDownloads, 'grok-0.2.33-macos-aarch64'), 0o755);
    fs.symlinkSync(emptyConfigDir, hostGrok, 'dir');

    const result = runVersionSync(home, "listInstalledVersions('grok')") as string[];

    expect(result).toEqual(['0.2.33']);
  });
});

// `installVersion` derives an `npm install <pkg>@<version>` spec from `version`,
// which originates from the `agents add pkg@<version>` CLI arg or a
// `.agents-version` pin. The argv-form execFile call cannot be reached for a
// tainted version because VERSION_RE rejects it at the source (versions.ts).
// These tests assert the rejection happens before any npm exec, so a malicious
// version can never escape into a shell.
function runInstallVersion(home: string, agent: string, version: string, extraPathDir?: string): { ok: boolean; error?: string; result?: { success: boolean; installedVersion?: string; error?: string } } {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { installVersion } from ${JSON.stringify(moduleUrl)};
    (async () => {
      try {
        const r = await installVersion(${JSON.stringify(agent)}, ${JSON.stringify(version)});
        console.log(JSON.stringify({ ok: true, result: r }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
  `], {
    env: {
      ...process.env,
      HOME: home,
      ...(extraPathDir ? { PATH: `${extraPathDir}${path.delimiter}${process.env.PATH}` } : {}),
    },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('installVersion version validation', () => {
  const malicious = [
    'latest; touch /tmp/pwned',
    '1.0.0 && rm -rf ~',
    '$(touch /tmp/pwned)',
    '`touch /tmp/pwned`',
    '1.0.0|cat /etc/passwd',
    '--registry=http://evil.example.com',
  ];

  for (const version of malicious) {
    it(`rejects malicious version before any npm exec: ${JSON.stringify(version)}`, () => {
      const home = makeTempHome();
      const outcome = runInstallVersion(home, 'codex', version);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('Invalid version');
      // No version dir was created — rejection happened at the source, before
      // ensureAgentsDir / npm install could run.
      expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'codex'))).toBe(false);
    });
  }

});

function runInstallVersionWithScript(
  home: string,
  agent: string,
  version: string,
  installScript: string,
  extraPathDir?: string,
  // Full PATH replacement (ignores extraPathDir and the inherited PATH) — for
  // tests that must guarantee NO real agent binary on this machine's own
  // PATH (e.g. this repo's own dev box has a real `grok` shim) can leak in
  // and make a "the binary isn't resolvable yet" scenario silently pass.
  fullPathOverride?: string
): { ok: boolean; error?: string; result?: { success: boolean; installedVersion?: string; error?: string } } {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  const agentsUrl = pathToFileURL(path.resolve('src/lib/agents.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { installVersion } from ${JSON.stringify(moduleUrl)};
    import { AGENTS } from ${JSON.stringify(agentsUrl)};
    (async () => {
      try {
        AGENTS[${JSON.stringify(agent)}].installScript = ${JSON.stringify(installScript)};
        const r = await installVersion(${JSON.stringify(agent)}, ${JSON.stringify(version)});
        console.log(JSON.stringify({ ok: true, result: r }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
  `], {
    env: {
      ...process.env,
      HOME: home,
      ...(fullPathOverride
        ? { PATH: fullPathOverride }
        : extraPathDir ? { PATH: `${extraPathDir}${path.delimiter}${process.env.PATH}` } : {}),
    },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('installVersion Grok binary relocation', () => {
  it.skipIf(process.platform === 'win32')('moves the current binary into the requested account-slot label and records its release', () => {
    const home = makeTempHome();
    const oldConfigDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.32', 'home', '.grok');
    const hostGrok = path.join(home, '.grok');
    const binDir = path.join(home, 'fakebin');

    fs.mkdirSync(path.join(oldConfigDir, 'downloads'), { recursive: true });
    fs.symlinkSync(oldConfigDir, hostGrok, 'dir');

    // A `grok` on PATH lets `getCliVersionFromPath` resolve `latest` to 0.2.101.
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 0.2.101"; exit 0; fi\nexit 0\n', 'utf-8');
    fs.chmodSync(stub, 0o755);

    // A concrete self-updating slot reuses the already-installed live release
    // instead of rerunning the vendor installer. Seed the previous active
    // home's real download exactly as that live installation would.
    const existingVersioned = path.join(oldConfigDir, 'downloads', 'grok-0.2.101-macos-aarch64');
    fs.writeFileSync(existingVersioned, Buffer.alloc(1_000_001));
    fs.chmodSync(existingVersioned, 0o755);
    fs.copyFileSync(existingVersioned, path.join(oldConfigDir, 'downloads', 'grok-macos-aarch64'));

    const script = [
      'mkdir -p ~/.grok/downloads',
      'printf \'#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "grok 0.2.101"; exit 0; fi\\nexit 0\\n\' > ~/.grok/downloads/grok-0.2.101-macos-aarch64',
      'chmod +x ~/.grok/downloads/grok-0.2.101-macos-aarch64',
      'cp ~/.grok/downloads/grok-0.2.101-macos-aarch64 ~/.grok/downloads/grok-macos-aarch64',
    ].join(' && ');

    const outcome = runInstallVersionWithScript(home, 'grok', '0.2.77', script, binDir);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.result?.installedVersion).toBe('0.2.77');

    const targetDownloads = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.77', 'home', '.grok', 'downloads');
    expect(fs.existsSync(path.join(targetDownloads, 'grok-0.2.101-macos-aarch64'))).toBe(true);
    expect(fs.existsSync(path.join(targetDownloads, 'grok-macos-aarch64'))).toBe(true);
    expect(fs.existsSync(existingVersioned)).toBe(true);

    const record = JSON.parse(fs.readFileSync(
      path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.77', 'installation.json'),
      'utf-8',
    ));
    expect(record.label).toBe('0.2.77');
    expect(record.releaseVersion).toBe('0.2.101');

    const result = runVersionSync(home, "listInstalledVersions('grok')") as string[];
    expect(result).toContain('0.2.77');
  });

  it.skipIf(process.platform === 'win32')('copies a current Grok binary whose filename omits the release', () => {
    const home = makeTempHome();
    const oldDownloads = path.join(home, '.agents', '.history', 'versions', 'grok', '1.0.5', 'home', '.grok', 'downloads');
    fs.mkdirSync(oldDownloads, { recursive: true });
    fs.symlinkSync(path.dirname(oldDownloads), path.join(home, '.grok'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'meta.json'), JSON.stringify({ defaults: { grok: '1.0.5' } }));

    const genericBinary = path.join(oldDownloads, 'grok-linux-x86_64');
    fs.writeFileSync(genericBinary, Buffer.alloc(1_000_001));
    fs.chmodSync(genericBinary, 0o755);

    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.5"; exit 0; fi\nexit 0\n', 'utf-8');
    fs.chmodSync(stub, 0o755);

    const outcome = runInstallVersionWithScript(home, 'grok', '0.2.101', 'exit 0', binDir);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.result?.installedVersion).toBe('0.2.101');
    expect(fs.existsSync(genericBinary)).toBe(true);
    expect(fs.existsSync(path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'grok',
      '0.2.101',
      'home',
      '.grok',
      'downloads',
      'grok-linux-x86_64',
    ))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('ignores a release-named wrapper and copies the real versionless Grok binary', () => {
    const home = makeTempHome();
    const oldDownloads = path.join(home, '.agents', '.history', 'versions', 'grok', '1.0.5', 'home', '.grok', 'downloads');
    fs.mkdirSync(oldDownloads, { recursive: true });
    fs.symlinkSync(path.dirname(oldDownloads), path.join(home, '.grok'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'meta.json'), JSON.stringify({ defaults: { grok: '1.0.5' } }));
    fs.writeFileSync(path.join(oldDownloads, 'grok-1.0.5-linux-x86_64'), '#!/bin/sh\nexit 1\n');
    const realBinary = path.join(oldDownloads, 'grok-linux-x86_64');
    fs.writeFileSync(realBinary, Buffer.alloc(1_000_001));
    fs.chmodSync(realBinary, 0o755);

    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 1.0.5"; exit 0; fi\nexit 0\n', 'utf-8');
    fs.chmodSync(stub, 0o755);

    const outcome = runInstallVersionWithScript(home, 'grok', '0.2.101', 'exit 0', binDir);
    const targetDownloads = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.101', 'home', '.grok', 'downloads');
    expect(outcome.result?.success).toBe(true);
    expect(fs.statSync(path.join(targetDownloads, 'grok-linux-x86_64')).size).toBe(1_000_001);
    expect(fs.existsSync(path.join(targetDownloads, 'grok-1.0.5-linux-x86_64'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails loudly instead of creating a literal "latest" version dir when the post-install version probe never resolves (regression)', () => {
    const home = makeTempHome();
    const oldConfigDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.106', 'home', '.grok');
    const hostGrok = path.join(home, '.grok');

    fs.mkdirSync(path.join(oldConfigDir, 'downloads'), { recursive: true });
    fs.symlinkSync(oldConfigDir, hostGrok, 'dir');

    // No `grok` stub on PATH at all — `getCliVersionFromPath`'s
    // `execFileAsync('grok', ['--version'])` fails every time (ENOENT),
    // simulating the installer's binary not yet being resolvable in this exec
    // context right after the curl installer exits.
    const script = [
      'mkdir -p ~/.grok/downloads',
      'printf \'#!/bin/sh\\nexit 0\\n\' > ~/.grok/downloads/grok-0.2.118-linux-x86_64',
      'chmod +x ~/.grok/downloads/grok-0.2.118-linux-x86_64',
    ].join(' && ');

    // Only bare system dirs on PATH — no real `grok` binary this machine
    // happens to have installed can resolve and defeat the "not yet
    // resolvable" scenario this test exercises.
    const bareSystemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    const outcome = runInstallVersionWithScript(home, 'grok', 'latest', script, undefined, bareSystemPath);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.error).toContain('could not be determined');

    // No bogus `versions/grok/latest/` dir, and the real binary is left in
    // place (not silently lost) for a retry to pick up.
    const staleLatestDir = path.join(home, '.agents', '.history', 'versions', 'grok', 'latest');
    expect(fs.existsSync(staleLatestDir)).toBe(false);
    expect(fs.existsSync(path.join(oldConfigDir, 'downloads', 'grok-0.2.118-linux-x86_64'))).toBe(true);
  }, 10000);

  it.skipIf(process.platform === 'win32')('self-heals a binary stranded in an unrelated version home by an earlier probe-failed install', () => {
    const home = makeTempHome();
    // The `latest`-labeled pseudo-version from a past probe-failed install
    // (see the regression test above) — empty, but still the current
    // `~/.grok` symlink target, exactly as `reconcileStaleLatestDir` would
    // leave it before the real version name is known.
    const staleLatestConfigDir = path.join(home, '.agents', '.history', 'versions', 'grok', 'latest', 'home', '.grok');
    const hostGrok = path.join(home, '.grok');
    fs.mkdirSync(path.join(staleLatestConfigDir, 'downloads'), { recursive: true });
    fs.symlinkSync(staleLatestConfigDir, hostGrok, 'dir');

    // The real binary from that earlier install, stranded in a wholly
    // unrelated previous-default version home (not `latest`, not the
    // version now being installed).
    const strandedConfigDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.106', 'home', '.grok');
    fs.mkdirSync(path.join(strandedConfigDir, 'downloads'), { recursive: true });
    // Filename ("0.2.118") deliberately does not match this version-home's
    // name ("0.2.106") — the exact scenario RUSH-2459's fallback fix targets.
    // The sweep below only visits this dir because listInstalledVersions
    // still counts "0.2.106" as installed, which now requires a real-sized
    // (>=1MB) grok-* candidate (resolveGrokFallbackBinary's size floor) — pad
    // past that so this test keeps exercising the self-heal sweep itself,
    // not the size floor.
    fs.writeFileSync(
      path.join(strandedConfigDir, 'downloads', 'grok-0.2.118-linux-x86_64'),
      `#!/bin/sh\n${'# '.repeat(600_000)}\nif [ "$1" = "--version" ]; then echo "grok 0.2.118"; exit 0; fi\nexit 0\n`,
      'utf-8'
    );
    fs.chmodSync(path.join(strandedConfigDir, 'downloads', 'grok-0.2.118-linux-x86_64'), 0o755);

    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'grok');
    fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 0.2.118"; exit 0; fi\nexit 0\n', 'utf-8');
    fs.chmodSync(stub, 0o755);

    // This install's own installer run drops nothing new — it only exercises
    // relocation's sweep of OTHER version homes for the already-stranded file.
    const outcome = runInstallVersionWithScript(home, 'grok', 'latest', 'true', binDir);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.result?.installedVersion).toBe('0.2.118');

    const targetDownloads = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.118', 'home', '.grok', 'downloads');
    expect(fs.existsSync(path.join(targetDownloads, 'grok-0.2.118-linux-x86_64'))).toBe(true);
  }, 10000);

  it.skipIf(process.platform === 'win32')('refuses to update a self-updating agent into a version dir already owned by a different account', () => {
    const home = makeTempHome();

    // Two accounts already installed as two distinct versions — the state
    // BOTH accounts self-updating to the SAME upstream release would collide
    // into. accountA (0.2.118) is the collision target; accountB (0.2.32) is
    // the currently-default account driving this update.
    const grokAuth = (email: string, userId: string) => JSON.stringify({
      'https://auth.x.ai::client-id': {
        email,
        user_id: userId,
        refresh_token: `refresh-${userId}`,
        create_time: '2026-08-01T00:00:00Z',
      },
    });
    const accountADir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.118', 'home', '.grok');
    fs.mkdirSync(path.join(accountADir, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(accountADir, 'auth.json'), grokAuth('accountA@example.com', 'user-a'), 'utf-8');

    const accountBDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.32', 'home', '.grok');
    fs.mkdirSync(path.join(accountBDir, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(accountBDir, 'auth.json'), grokAuth('accountB@example.com', 'user-b'), 'utf-8');

    // accountB (0.2.32) is the global default this update runs as.
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents', 'agents.yaml'),
      'agents:\n  grok: "0.2.32"\n',
      'utf-8'
    );

    const hostGrok = path.join(home, '.grok');
    fs.symlinkSync(accountBDir, hostGrok, 'dir');

    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'grok');
    // The self-updater always reports the SAME upstream release ("0.2.118")
    // regardless of which account's home invoked it — the real mechanism that
    // makes two accounts collide on one version directory.
    fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 0.2.118"; exit 0; fi\nexit 0\n', 'utf-8');
    fs.chmodSync(stub, 0o755);

    const outcome = runInstallVersionWithScript(home, 'grok', 'latest', 'true', binDir);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.error ?? '').toContain('accountA@example.com');
    expect(outcome.result?.error ?? '').toContain('accountB@example.com');

    // accountA's install must be untouched — refusing the update must not
    // have written or damaged the file that was already there.
    const targetAuth = JSON.parse(fs.readFileSync(path.join(accountADir, 'auth.json'), 'utf-8'));
    expect(targetAuth['https://auth.x.ai::client-id'].email).toBe('accountA@example.com');
  }, 10000);
});

// RUSH-2459: grok self-updates its binary in place while running under the
// shim, so a version-home's downloads dir can accumulate several `grok-*`
// files whose names have drifted away from that version-home's pinned
// version. Reproduced on yosemite-s0: version-home 0.2.82 held a real
// self-updated `grok-1.0.0-linux-aarch64` PLUS a stale, unrelated 99-byte
// `grok-0.2.118-linux-aarch64` wrapper script (`exec cursor-agent "$@"`) that
// sorted alphabetically before it — the old "no exact match -> first file"
// fallback silently launched the wrapper, so `agents run grok` ran Cursor.
describe('resolveGrokFallbackBinary (RUSH-2459)', () => {
  function makeDownloadsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-grok-downloads-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeGrokFile(dir: string, name: string, bytes: number, mtime: Date): string {
    const full = path.join(dir, name);
    fs.writeFileSync(full, Buffer.alloc(bytes, 'a'));
    fs.chmodSync(full, 0o755);
    fs.utimesSync(full, mtime, mtime);
    return full;
  }

  it('never picks a stray non-binary artifact under the size floor, even when it sorts first', () => {
    const dir = makeDownloadsDir();
    // Sorts alphabetically FIRST ("0" < "1" < "l") and is exactly the shape of
    // the real stray artifact found on yosemite-s0 (a 99-byte cursor-agent
    // wrapper). Real grok binaries are ~127MB; 2MB here is enough to clear the
    // 1MB floor without paying to write a full-size fixture in every test run.
    writeGrokFile(dir, 'grok-0.2.118-linux-aarch64', 99, new Date('2026-08-01T19:35:00Z'));
    const real = writeGrokFile(dir, 'grok-1.0.0-linux-aarch64', 2_000_000, new Date('2026-08-09T18:38:00Z'));
    writeGrokFile(dir, 'grok-linux-aarch64', 2_000_000, new Date('2026-08-07T13:50:00Z'));

    expect(resolveGrokFallbackBinary(dir)).toBe(real);
  });

  it('prefers the most recently modified candidate among several real-sized binaries', () => {
    const dir = makeDownloadsDir();
    writeGrokFile(dir, 'grok-linux-aarch64', 2_000_000, new Date('2026-08-01T00:00:00Z'));
    const newest = writeGrokFile(dir, 'grok-1.0.5-linux-aarch64', 2_000_000, new Date('2026-08-05T00:00:00Z'));

    expect(resolveGrokFallbackBinary(dir)).toBe(newest);
  });

  it('fails loud (returns null) instead of guessing when every candidate is under the size floor', () => {
    const dir = makeDownloadsDir();
    writeGrokFile(dir, 'grok-0.2.118-linux-aarch64', 99, new Date());
    writeGrokFile(dir, 'grok-stub-macos-arm64', 40, new Date());

    expect(resolveGrokFallbackBinary(dir)).toBeNull();
  });

  it('returns null for an empty or missing downloads dir', () => {
    const dir = makeDownloadsDir();
    expect(resolveGrokFallbackBinary(dir)).toBeNull();
    expect(resolveGrokFallbackBinary(path.join(dir, 'does-not-exist'))).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('getBinaryPath resolves through the same validated fallback (not the first alphabetical grok-* file)', () => {
    const home = makeTempHome();
    const version = '0.2.82';
    const downloads = path.join(home, '.agents', '.history', 'versions', 'grok', version, 'home', '.grok', 'downloads');
    fs.mkdirSync(downloads, { recursive: true });
    writeGrokFile(downloads, 'grok-0.2.118-linux-aarch64', 99, new Date('2026-08-01T19:35:00Z'));
    writeGrokFile(downloads, 'grok-1.0.0-linux-aarch64', 2_000_000, new Date('2026-08-09T18:38:00Z'));

    const result = runVersionSync(home, `getBinaryPath('grok', ${JSON.stringify(version)})`) as string;
    expect(result).toBe(path.join(downloads, 'grok-1.0.0-linux-aarch64'));
  });
});

// `resolveVersionAlias` is the shared @selector vocabulary (latest / oldest /
// default / pinned / explicit) every `agents <cmd> agent@<token>` reads. droid
// installs a single global binary (~/.local/bin/droid) shared across version
// dirs, so a fixture is just N dirs + one binary — every dir reads as installed.
function runResolveAlias(home: string, agent: string, raw: string | undefined): string | null {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { resolveVersionAlias } from ${JSON.stringify(moduleUrl)};
    const r = resolveVersionAlias(${JSON.stringify(agent)}, ${JSON.stringify(raw ?? null)});
    console.log(JSON.stringify({ v: r === undefined ? null : r }));
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return (JSON.parse(child.stdout.trim()) as { v: string | null }).v;
}

function installDroidVersions(home: string, versions: string[]): void {
  for (const v of versions) {
    fs.mkdirSync(path.join(droidVersionDir(home, v), 'home'), { recursive: true });
  }
  // droid's binary is global and per-host, not per-version (getBinaryPath).
  // Mirror getBinaryPath's platform split so the fixture binary lands where the
  // SUT actually looks: Windows -> ~/bin/droid.exe, macOS/Linux -> ~/.local/bin/droid.
  const bin = process.platform === 'win32'
    ? path.join(home, 'bin', 'droid.exe')
    : path.join(home, '.local', 'bin', 'droid');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.chmodSync(bin, 0o755);
}

// Numeric-vs-lexical ordering must be exercised on a genuinely MULTI-version
// agent. droid is now single-binary (its dirs collapse to one — RUSH-1321), so
// use antigravity (cliCommand `agy`): self-updating but per-version binary at
// `node_modules/.bin/agy`, so its version dirs are NOT collapsed.
function installAntigravityVersions(home: string, versions: string[]): void {
  for (const v of versions) {
    const binDir = path.join(home, '.agents', '.history', 'versions', 'antigravity', v, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'agy');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8');
    fs.chmodSync(bin, 0o755);
  }
}

describe('resolveVersionAlias @selectors', () => {
  // Versions chosen so numeric ordering disagrees with lexical ordering:
  // numeric oldest=0.9.0, newest=0.158.0; lexical would put "0.10.0" first.
  const VERSIONS = ['0.9.0', '0.10.0', '0.158.0'];

  it("resolves 'latest' to the highest installed version (numeric, not lexical)", () => {
    const home = makeTempHome();
    installAntigravityVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'antigravity', 'latest')).toBe('0.158.0');
  });

  it("resolves 'oldest' to the lowest installed version (numeric, not lexical)", () => {
    const home = makeTempHome();
    installAntigravityVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'antigravity', 'oldest')).toBe('0.9.0');
  });

  it("treats 'pinned' as a synonym for 'default' — both defer to the caller (undefined)", () => {
    const home = makeTempHome();
    installDroidVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'droid', 'pinned')).toBeNull();
    expect(runResolveAlias(home, 'droid', 'default')).toBeNull();
  });

  it('passes an explicit installed version through unchanged', () => {
    const home = makeTempHome();
    installAntigravityVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'antigravity', '0.10.0')).toBe('0.10.0');
  });

  it("defers an absent/empty token to the caller (undefined)", () => {
    const home = makeTempHome();
    installDroidVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'droid', undefined)).toBeNull();
  });

  it("treats 'any' like default/pinned — no version constraint (undefined)", () => {
    const home = makeTempHome();
    installDroidVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'droid', 'any')).toBeNull();
  });
});

describe('resolveVersionAliasLoose — @any', () => {
  it('treats "any" like "default": no version constraint (undefined)', () => {
    const home = makeTempHome();
    const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import { resolveVersionAlias, resolveVersionAliasLoose } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify({
        strictAny: resolveVersionAlias('claude', 'any') ?? null,
        looseAny: resolveVersionAliasLoose('claude', 'any') ?? null,
        strictDefault: resolveVersionAlias('claude', 'default') ?? null,
      }));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ strictAny: null, looseAny: null, strictDefault: null });
  });
});

describe('buildRepoScopedSelection — agents sync <agent> --repo <name>', () => {
  // Scaffold a user skill and a system skill in an isolated HOME, then confirm
  // scoping to one repo returns only that layer's resources. Guards against
  // layer-misattribution — the bug where `--repo system` would sweep in (or
  // drop) the wrong repo's skills.
  function runBuildScoped(home: string, repo: string): { skills?: string[]; memory?: string[] | 'all' } {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import { buildRepoScopedSelection } from ${JSON.stringify(moduleUrl)};
      const home = ${JSON.stringify(home)};
      console.log(JSON.stringify(buildRepoScopedSelection(${JSON.stringify(repo)}, home)));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  }

  function scaffoldSkills(home: string): void {
    const userSkill = path.join(home, '.agents', 'skills', 'user-only', 'SKILL.md');
    const systemSkill = path.join(home, '.agents', '.system', 'skills', 'system-only', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.mkdirSync(path.dirname(systemSkill), { recursive: true });
    fs.writeFileSync(userSkill, 'user skill body', 'utf-8');
    fs.writeFileSync(systemSkill, 'system skill body', 'utf-8');
  }

  it('scopes to the system repo — only system-layer skills, not user', () => {
    const home = makeTempHome();
    scaffoldSkills(home);
    const sel = runBuildScoped(home, 'system');
    expect(sel.skills).toEqual(['system-only']);
  });

  it('expands nested hooks/<event>/ scripts under system:* (not the group dir name)', () => {
    // After hooks/<event-name>/<script> layout, listResources must expand group
    // dirs so buildRepoScopedSelection('system') includes git-guard.sh — otherwise
    // agents sync --force never re-copies nested system hooks into version homes.
    const home = makeTempHome();
    const nested = path.join(home, '.agents', '.system', 'hooks', 'pre-tool-use');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'git-guard.sh'), '#!/bin/sh\necho multi\n', 'utf-8');
    fs.chmodSync(path.join(nested, 'git-guard.sh'), 0o755);
    // Flat top-level still works.
    fs.writeFileSync(
      path.join(home, '.agents', '.system', 'hooks', 'registration_test.sh'),
      '#!/bin/sh\n',
      'utf-8',
    );
    // User-layer hook must NOT appear under --repo system.
    const userHook = path.join(home, '.agents', 'hooks', 'user-only.sh');
    fs.mkdirSync(path.dirname(userHook), { recursive: true });
    fs.writeFileSync(userHook, '#!/bin/sh\n', 'utf-8');

    const sel = runBuildScoped(home, 'system') as { hooks?: string[] };
    expect(sel.hooks).toEqual(expect.arrayContaining(['git-guard.sh', 'registration_test.sh']));
    expect(sel.hooks).not.toContain('pre-tool-use');
    expect(sel.hooks).not.toContain('user-only.sh');
  });

  it('scopes to the user repo — only user-layer skills, not system', () => {
    const home = makeTempHome();
    scaffoldSkills(home);
    const sel = runBuildScoped(home, 'user');
    expect(sel.skills).toEqual(['user-only']);
  });

  it('recompiles a STALE memory file through a real repo-scoped sync (RUSH-1354)', () => {
    const home = makeTempHome();
    // The composed rules-memory file is a merge of ALL layers, so a repo-scoped
    // sync must still recompile it — otherwise a rules change followed by a
    // repo-scoped `agents sync <agent> <repo>` silently strands the file at its
    // old content. Same rules fixture the "writes missing grok AGENTS.md" test
    // uses; here we PRE-SEED a stale AGENTS.md and prove the scoped sync
    // overwrites it with the freshly composed content.
    const rulesDir = path.join(home, '.agents', '.system', 'rules');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'rules.yaml'),
      'presets:\n  default:\n    subrules:\n      - core\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), 'fresh scoped memory body\n', 'utf-8');

    // Pre-seed a stale memory file in the version home — this is what a prior
    // sync left behind before the rules changed.
    const agentDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok');
    const agentsPath = path.join(agentDir, 'AGENTS.md');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(agentsPath, 'STALE memory body — must be overwritten\n', 'utf-8');

    // The scoped selection now recomposes memory from all layers (memory:'all',
    // not the old []-skip sentinel).
    expect(runBuildScoped(home, 'system').memory).toEqual('all');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('grok', '0.2.33', buildRepoScopedSelection('system', home), { cwd: home })"
    ) as { memory: string[] };

    expect(result.memory).toContain('AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);
    const written = fs.readFileSync(agentsPath, 'utf-8');
    expect(written).toContain('fresh scoped memory body');
    expect(written).not.toContain('STALE memory body');
  });
});

describe('unionResourceSelections + mergeRepoScopedSelections — interactive multi-repo sync', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function evalExpr(home: string, expr: string): any {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import * as V from ${JSON.stringify(moduleUrl)};
      const home = ${JSON.stringify(home)};
      console.log(JSON.stringify(${expr}));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  }

  it('unions selections and dedupes names per kind', () => {
    const home = makeTempHome();
    const out = evalExpr(home,
      "V.unionResourceSelections([{skills:['a','b']},{skills:['b','c'],commands:['x']}], false)");
    expect(out.skills.sort()).toEqual(['a', 'b', 'c']);
    expect(out.commands).toEqual(['x']);
    expect(out.memory).toEqual([]); // includeMemory=false → skip sentinel
  });

  it('includeMemory=true requests a full memory write', () => {
    const home = makeTempHome();
    const out = evalExpr(home, "V.unionResourceSelections([{skills:['a']}], true)");
    expect(out.memory).toBe('all');
  });

  it('merges system + user skills and writes memory when a memory layer is picked', () => {
    const home = makeTempHome();
    const userSkill = path.join(home, '.agents', 'skills', 'user-only', 'SKILL.md');
    const systemSkill = path.join(home, '.agents', '.system', 'skills', 'system-only', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.mkdirSync(path.dirname(systemSkill), { recursive: true });
    fs.writeFileSync(userSkill, 'user skill body', 'utf-8');
    fs.writeFileSync(systemSkill, 'system skill body', 'utf-8');

    const out = evalExpr(home, "V.mergeRepoScopedSelections(['user','system'], home)");
    expect(out.skills.sort()).toEqual(['system-only', 'user-only']);
    expect(out.memory).toBe('all'); // user/system layer selected → memory written
  });

  it('a project-only pick leaves the memory file untouched', () => {
    const home = makeTempHome();
    const out = evalExpr(home, "V.mergeRepoScopedSelections(['project'], home)");
    expect(out.memory).toEqual([]); // neither user nor system → skip sentinel
  });
});

// ── isVersionInstalled / listInstalledVersions probe the real launch binary ──
//
// Regression for the "gutted install" bug: a vendor auto-updater destroyed the
// real per-version claude binary (node_modules/@anthropic-ai/claude-code/bin/
// claude.exe) while leaving the version dir, its package.json, and the tiny
// node_modules/.bin/claude(+.cmd) wrappers in place. The old check keyed
// "installed" on the wrapper, so `agents add` skipped repair and the picker
// counted the dead install healthy — `agents run` then died at spawn.

function versionDir(home: string, agent: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', agent, version);
}

// The name of the real launch binary the package's `bin` entry points at. We
// don't use ".exe" so the fixture is platform-neutral — getPackageBinaryPath
// reads whatever the installed package.json declares, which is exactly the
// point of the fix.
const CLAUDE_BIN_REL = 'bin/claude-launcher';

/**
 * Build a claude version dir. Always writes the version-dir marker package.json
 * and the node_modules/.bin/claude(+.cmd) wrappers npm leaves behind. When
 * `realBinary` is true, also writes the package's actual launch binary — omit
 * it to reproduce a gutted install.
 */
function makeClaudeVersion(home: string, version: string, opts: { realBinary: boolean }): void {
  const dir = versionDir(home, 'claude', version);
  const pkgRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });

  // Version-dir marker (present even on a gutted install).
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `agents-claude-${version}`, private: true }), 'utf-8');
  // Installed package's package.json — declares the real launch binary.
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version, bin: { claude: CLAUDE_BIN_REL } }), 'utf-8');
  // The node_modules/.bin wrappers npm always leaves behind (getBinaryPath's target).
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude'), '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude.cmd'), '@echo off\r\n', 'utf-8');

  if (opts.realBinary) {
    fs.writeFileSync(path.join(pkgRoot, CLAUDE_BIN_REL), 'REAL BINARY', 'utf-8');
  }
}

function runNamedExport(home: string, importName: string, callExpr: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
    import { ${importName} } from ${JSON.stringify(moduleUrl)};
    const home = ${JSON.stringify(home)};
    console.log(JSON.stringify(${callExpr}));
  `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('isVersionInstalled — probes the real launch binary', () => {
  it('reports a healthy install (package bin present) as installed', () => {
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.196', { realBinary: true });
    expect(runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')")).toBe(true);
  });

  it('reports a gutted install (real bin destroyed, wrappers + package.json left behind) as NOT installed', () => {
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.196', { realBinary: false });
    // The node_modules/.bin/claude wrapper still exists — the old dir/wrapper
    // check would call this installed. The launch binary is gone, so it isn't.
    expect(fs.existsSync(path.join(versionDir(home, 'claude', '2.1.196'), 'node_modules', '.bin', 'claude'))).toBe(true);
    expect(runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')")).toBe(false);
  });

  it('reports a dir-only install (package.json marker, no node_modules) as NOT installed', () => {
    const home = makeTempHome();
    const dir = versionDir(home, 'claude', '2.1.196');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agents-claude-2.1.196' }), 'utf-8');
    expect(runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')")).toBe(false);
  });
});

describe('the add fast-path gate flips a gutted install to the repair branch', () => {
  it('a gutted dir is NOT alreadyInstalled, so `agents add` proceeds to installVersion', () => {
    // `agents add` computes `alreadyInstalled = isVersionInstalled(agent, version)`
    // and only skips install when it is true (src/commands/versions.ts). A gutted
    // dir must return false so add re-runs its install step to repair it rather
    // than printing "already installed".
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.196', { realBinary: false });
    const alreadyInstalled = runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')");
    expect(alreadyInstalled).toBe(false);
  });
});

describe('listInstalledVersions — excludes gutted installs from the picker', () => {
  it('returns only versions whose real launch binary exists', () => {
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.195', { realBinary: true });
    makeClaudeVersion(home, '2.1.196', { realBinary: false }); // gutted
    const versions = runNamedExport(home, 'listInstalledVersions', "listInstalledVersions('claude')");
    expect(versions).toEqual(['2.1.195']);
  });
});

// Regression (RUSH-1420): removing the version that is the current global
// default must never leave a dangling default pointer — every launcher shim
// resolves the default, so a stale pointer breaks `agents run` and the default
// shim outright ("no installed default for claude"). The fix reassigns the
// default to the newest remaining install, or clears it cleanly when the last
// version goes.
describe('removeVersion — default reassignment when removing the pinned default', () => {
  // Lay down a claude version on disk the way listInstalledVersions expects:
  // a real binary file at <versionDir>/node_modules/.bin/claude.
  function installClaudeVersion(home: string, version: string): void {
    const binDir = path.join(home, '.agents', '.history', 'versions', 'claude', version, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n', 'utf-8');
  }

  // One subprocess so the module-level HOME + version caches stay consistent:
  // set the default, remove a version, then read back the resolved default.
  function runRemoveScenario(home: string, defaultVersion: string, versionToRemove: string): { removed: boolean; defaultAfter: string | null } {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import { setGlobalDefault, getGlobalDefault, removeVersion } from ${JSON.stringify(moduleUrl)};
      setGlobalDefault('claude', ${JSON.stringify(defaultVersion)});
      const removed = removeVersion('claude', ${JSON.stringify(versionToRemove)});
      // removeVersion prints a human notice to stdout; tag the machine-readable
      // result so the parent can pick it out of the surrounding output.
      console.log('__RESULT__' + JSON.stringify({ removed, defaultAfter: getGlobalDefault('claude') }));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    const line = child.stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
    expect(line, child.stdout).toBeTruthy();
    return JSON.parse(line!.slice('__RESULT__'.length));
  }

  it('reassigns the default to the newest remaining version when siblings exist', () => {
    const home = makeTempHome();
    installClaudeVersion(home, '2.1.185');
    installClaudeVersion(home, '2.1.196');
    installClaudeVersion(home, '2.1.201');

    // 2.1.196 is the default and gets removed; 2.1.185 + 2.1.201 remain.
    const { removed, defaultAfter } = runRemoveScenario(home, '2.1.196', '2.1.196');

    expect(removed).toBe(true);
    // Newest remaining is 2.1.201 — not the newest overall (which was removed).
    expect(defaultAfter).toBe('2.1.201');
    // The removed version's binary is gone (soft-deleted to trash).
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.196', 'node_modules', '.bin', 'claude'))).toBe(false);
  });

  it('clears the default without a dangling pointer when the last version is removed', () => {
    const home = makeTempHome();
    installClaudeVersion(home, '2.1.196');

    const { removed, defaultAfter } = runRemoveScenario(home, '2.1.196', '2.1.196');

    expect(removed).toBe(true);
    // No versions remain → default cleared cleanly, not left pointing at a ghost.
    expect(defaultAfter).toBe(null);
  });
});

describe('system-scoped selection includes system-layer plugins (RUSH-3207)', () => {
  it('a `system` repo scope selects a system-layer plugin and excludes a user-layer one', () => {
    const home = makeTempHome();
    // One plugin in the system layer (~/.agents/.system/plugins), like `swarm`, and one
    // in the user layer (~/.agents/plugins). A valid name+version manifest is all
    // discoverPlugins needs to see them.
    for (const [rel, name] of [['.system/plugins', 'swarm'], ['plugins', 'mine']] as const) {
      const dir = path.join(home, '.agents', ...rel.split('/'), name, '.claude-plugin');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, version: '0.0.0' }));
    }
    const result = runVersionSync(
      home,
      `buildRepoScopedSelection('system', ${JSON.stringify(home)})`,
    ) as { plugins?: string[] };
    // Before the fix, resourceSourceMap hardcoded every plugin to the 'user' layer, so
    // `system:*` expanded to zero plugins and `agents sync <agent> system` silently
    // skipped system-layer plugins — the swarm-plugin bug.
    expect(result.plugins ?? []).toContain('swarm');
    expect(result.plugins ?? []).not.toContain('mine');
  });
});

// PHNX-3187: `available.hooks` carries the source filename WITH its extension
// (`git-guard.sh`), but the doctor/heal resource diff names a hook by its
// extensionless basename (`git-guard`). A heal pass feeds those diff names
// straight back as the selection, so the old exact-set filter matched nothing
// and `agents doctor --fix` could never reconcile a flagged hook. This is what
// left win-mini's guards permanently "held" once its diff flagged them.
describe('resolveHookSelection — basename-tolerant hook matching (PHNX-3187)', () => {
  const available = ['git-guard.sh', '10-feed-publish.py', 'json-field.sh', 'ask-user-question-guard.sh'];

  it('resolves extensionless diff/heal names to the extensioned available name', () => {
    expect(resolveHookSelection(['git-guard', 'json-field'], available)).toEqual([
      'git-guard.sh',
      'json-field.sh',
    ]);
  });

  it('resolves numbered .py hooks by basename too', () => {
    expect(resolveHookSelection(['10-feed-publish'], available)).toEqual(['10-feed-publish.py']);
  });

  it('still matches exact extensioned names (no regression for full-sync callers)', () => {
    expect(resolveHookSelection(['git-guard.sh', 'ask-user-question-guard.sh'], available)).toEqual([
      'git-guard.sh',
      'ask-user-question-guard.sh',
    ]);
  });

  it("'all' returns the whole available set unchanged", () => {
    expect(resolveHookSelection('all', available)).toEqual(available);
  });

  it('drops a selection entry that matches nothing, and de-duplicates', () => {
    expect(resolveHookSelection(['git-guard', 'git-guard.sh', 'nope'], available)).toEqual(['git-guard.sh']);
  });

  it('undefined selection yields nothing', () => {
    expect(resolveHookSelection(undefined, available)).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('keeps a pinned self-updating install as a stable label while recording the current release', () => {
    const home = makeTempHome();
    // A valid version passes VERSION_RE. `hermes` is self-updating with no VERSION
    // token (unmanagedBinary: 'path'). A `hermes` on PATH makes the single binary
    // read as already-installed, so the pin is a network-free no-op — NOT the old
    // `does not support version-pinned installs` hard error, and NOT a real install.
    // (Repointed from a since-removed brew-installed harness.)
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'hermes');
    fs.writeFileSync(stub, '#!/bin/sh\necho "hermes 2.12.1"\n');
    fs.chmodSync(stub, 0o755);

    const outcome = runInstallVersion(home, 'hermes', '0.0.0-rc.1', binDir);
    expect(outcome.ok).toBe(true);
    const result = outcome.result;
    expect(result?.success).toBe(true);
    expect(result?.installedVersion).toBe('0.0.0-rc.1');
    const record = JSON.parse(fs.readFileSync(
      path.join(home, '.agents', '.history', 'versions', 'hermes', '0.0.0-rc.1', 'installation.json'),
      'utf-8',
    ));
    expect(record.label).toBe('0.0.0-rc.1');
    expect(record.releaseVersion).toBe('2.12.1');
    expect(result?.error ?? '').not.toContain('Invalid version');
    expect(result?.error ?? '').not.toContain('does not support version-pinned installs');
  });
});
