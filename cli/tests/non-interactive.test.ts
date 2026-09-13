import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string };

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-non-interactive-'));
  // User dir: commands, agents.yaml live here
  const userDir = path.join(home, '.agents');
  fs.mkdirSync(userDir, { recursive: true });
  // System dir: update-check and versions live here.
  // Needs a .git dir so ensureInitialized() doesn't block commands.
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION.version }),
  );
  return home;
}

function writeCentralCommand(home: string, name: string, description = 'Test command'): void {
  const commandsDir = path.join(home, '.agents', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, `${name}.md`),
    `---\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeFakeManagedVersion(
  home: string,
  agent: string,
  version: string,
  cliName: string,
  script: string = '#!/bin/sh\nexit 0\n',
): void {
  const binaryDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binaryDir, { recursive: true });
  const binaryPath = path.join(binaryDir, cliName);
  fs.writeFileSync(binaryPath, script);
  fs.chmodSync(binaryPath, 0o755);
}

function writeLoggingManagedVersion(
  home: string,
  agent: string,
  version: string,
  cliName: string,
  logPath: string,
): void {
  writeFakeManagedVersion(
    home,
    agent,
    version,
    cliName,
    `#!/bin/sh\necho \"$HOME|$@\" >> \"${logPath}\"\nexit 0\n`,
  );
}

function writeFakeNpmInstaller(home: string, version: string): string {
  const binDir = path.join(home, 'bin');
  const npmPath = path.join(binDir, 'npm');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    npmPath,
    [
      '#!/bin/sh',
      // Production install probes `npm --version` before `npm install` —
      // respond so the install path proceeds instead of bailing with
      // "npm is not installed". See src/lib/installations/versions.ts:1124.
      'if [ "$1" = "--version" ]; then',
      '  echo "10.0.0"',
      '  exit 0',
      'fi',
      'if [ "$1" = "install" ]; then',
      '  mkdir -p node_modules/@openai/codex node_modules/.bin',
      `  printf '{"version":"${version}"}' > node_modules/@openai/codex/package.json`,
      '  printf "#!/bin/sh\\nexit 0\\n" > node_modules/.bin/codex',
      '  chmod 755 node_modules/.bin/codex',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(npmPath, 0o755);
  return binDir;
}

function writeLocalPackageRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-package-repo-'));
  fs.mkdirSync(path.join(repo, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'commands', 'review.md'),
    '---\ndescription: Review changes\n---\n\n# review\n',
  );
  return repo;
}

/** Version pins live in untracked JSON under .history/devices (not the tracked device doc). */
const DEVICE_ID = 'testdev';
function devicesRuntimeDir(home: string): string {
  return path.join(home, '.agents', '.history', 'devices');
}
function devicePinsPath(home: string): string {
  return path.join(devicesRuntimeDir(home), `pins-${DEVICE_ID}.json`);
}

function runAgents(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_REAL_HOME: home,
      SHELL: '/bin/zsh',
      AGENTS_SYNC_MACHINE_ID: DEVICE_ID,
      // Own pins dir — vitest setup.ts pins AGENTS_DEVICES_DIR fork-wide.
      AGENTS_DEVICES_DIR: devicesRuntimeDir(home),
      // This suite exercises real CLI usage against on-disk fixtures, including
      // legacy pre-migration `agents.yaml` layouts (`versions:`/`agents:` still
      // central rather than split into the machine-local history/device files) --
      // migration running is part of what a real non-dev install does on first
      // touch, and some fixtures below depend on it actually running. Dev builds
      // (this repo's own tsx/dist invocations, detectDevBuild()) default
      // AGENTS_SKIP_MIGRATION on to protect a real developer's ~/.agents/ while
      // iterating; override that default here since these are throwaway temp
      // homes, not a real developer's, and the whole point is exercising the
      // real non-dev-build behavior (RUSH-2749). A specific test can still force
      // it off via extraEnv.
      AGENTS_SKIP_MIGRATION: '0',
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

function runSessionDbScript(home: string, body: string): string {
  const result = spawnSync('node', ['--import', 'tsx', '--input-type=module', '--eval', body], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_REAL_HOME: home,
      SHELL: '/bin/zsh',
    },
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`session db script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function seedSessionRow(home: string, id: string, agent: string, version: string, filePath: string): void {
  runSessionDbScript(home, `
    import { getDB, closeDB } from './src/lib/session/db.ts';
    const db = getDB();
    db.prepare(\`
      INSERT OR REPLACE INTO sessions
        (id, short_id, agent, version, timestamp, file_path, is_team_origin)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    \`).run(
      ${JSON.stringify(id)},
      ${JSON.stringify(id.slice(0, 8))},
      ${JSON.stringify(agent)},
      ${JSON.stringify(version)},
      '2026-05-25T12:00:00.000Z',
      ${JSON.stringify(filePath)}
    );
    closeDB();
  `);
}

function readSessionFilePath(home: string, id: string): string | null {
  const output = runSessionDbScript(home, `
    import { getDB, closeDB } from './src/lib/session/db.ts';
    const db = getDB();
    const row = db.prepare('SELECT file_path FROM sessions WHERE id = ?').get(${JSON.stringify(id)});
    console.log(row?.file_path ?? '');
    closeDB();
  `);
  return output.length > 0 ? output : null;
}

function writeProfileYaml(
  home: string,
  name: string,
  body: {
    agent: string;
    version?: string;
    env?: Record<string, string>;
    provider?: string;
    description?: string;
  },
): void {
  const dir = path.join(home, '.agents', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const env = body.env ?? {};
  const lines: string[] = [
    `name: ${name}`,
    'host:',
    `  agent: ${body.agent}`,
  ];
  if (body.version) lines.push(`  version: ${body.version}`);
  if (body.provider) lines.push(`provider: ${body.provider}`);
  if (body.description) lines.push(`description: "${body.description}"`);
  lines.push('env:');
  for (const [k, v] of Object.entries(env)) {
    lines.push(`  ${k}: "${v}"`);
  }
  fs.writeFileSync(path.join(dir, `${name}.yml`), lines.join('\n') + '\n');
}

function seedNewerUpdateCache(home: string, futureVersion: string): void {
  const cacheDir = path.join(home, '.agents', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: futureVersion }),
  );
}

const tempHomes: string[] = [];
const tempRepos: string[] = [];

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
  while (tempRepos.length > 0) {
    const repo = tempRepos.pop()!;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Every case here drives the CLI through fake managed-version binaries written
// as `#!/bin/sh` scripts + `chmod 0o755` (writeFakeManagedVersion / fake npm
// installer). Shebang scripts don't execute on Windows and chmod is a no-op
// there, so the spawn path can't be exercised — this is a POSIX-tooling suite.
describe.skipIf(process.platform === 'win32')('non-interactive CLI usage', () => {
  it('shows a plain hint instead of opening a picker', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'demo');

    const result = runAgents(home, ['commands', 'view']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(combined).toContain('Selecting a command to view requires an interactive terminal.');
    expect(combined).toContain('agents commands view plan');
  });

  it('prunes a specific version while preserving home data and session rows', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    const version = '2.1.139';
    const sessionId = 'prune-session-row';
    writeFakeManagedVersion(home, 'claude', version, 'claude');
    const metaPath = path.join(home, '.agents', 'agents.yaml');
    fs.writeFileSync(metaPath, `versions:\n  claude:\n    "${version}":\n      rulesPreset: default\n`);

    const versionDir = path.join(home, '.agents', '.history', 'versions', 'claude', version);
    const sessionFile = path.join(versionDir, 'home', '.claude', 'projects', 'demo', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"user","message":{"content":"keep me"}}\n');
    seedSessionRow(home, sessionId, 'claude', version, sessionFile);

    const result = runAgents(home, ['prune', `claude@${version}`]);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(combined).toContain(`Moved Claude@${version} to trash`);
    expect(combined).toContain('Sessions remain accessible via `agents sessions`.');
    expect(combined).toContain(`Restore with: agents restore claude@${version}`);
    expect(fs.existsSync(versionDir)).toBe(false);

    const trashAgentDir = path.join(home, '.agents', '.history', 'trash', 'versions', 'claude', version);
    const stamps = fs.readdirSync(trashAgentDir);
    expect(stamps.length).toBe(1);
    const trashed = path.join(trashAgentDir, stamps[0]);

    const trashedSessionFile = path.join(trashed, 'home', '.claude', 'projects', 'demo', `${sessionId}.jsonl`);
    expect(fs.existsSync(path.join(trashed, 'node_modules', '.bin', 'claude'))).toBe(true);
    expect(fs.existsSync(trashedSessionFile)).toBe(true);

    const storedPath = readSessionFilePath(home, sessionId);
    expect(storedPath).toBe(trashedSessionFile);
    expect(fs.existsSync(storedPath!)).toBe(true);
    // versions: tracking now lives in the machine-local history file.
    expect(
      fs.readFileSync(path.join(home, '.agents', '.history', 'version-resources.json'), 'utf-8'),
    ).toContain(version);
  });

  it('keeps remove as an alias for version prune', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    const version = '0.130.0';
    writeFakeManagedVersion(home, 'codex', version, 'codex');

    const versionDir = path.join(home, '.agents', '.history', 'versions', 'codex', version);
    const result = runAgents(home, ['remove', `codex@${version}`]);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(combined).toContain(`Moved Codex@${version} to trash`);
    expect(fs.existsSync(versionDir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'trash', 'versions', 'codex', version))).toBe(true);
  });

  it.each(['rm', 'purge'])('treats %s as an alias for version prune', (verb) => {
    const home = makeTempHome();
    tempHomes.push(home);
    const version = '0.131.0';
    writeFakeManagedVersion(home, 'codex', version, 'codex');

    const versionDir = path.join(home, '.agents', '.history', 'versions', 'codex', version);
    const result = runAgents(home, [verb, `codex@${version}`]);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(combined).toContain(`Moved Codex@${version} to trash`);
    expect(fs.existsSync(versionDir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'trash', 'versions', 'codex', version))).toBe(true);
  });

  it('restores a soft-deleted version via the top-level restore command', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    const version = '0.132.0';
    writeFakeManagedVersion(home, 'codex', version, 'codex');

    const versionDir = path.join(home, '.agents', '.history', 'versions', 'codex', version);
    expect(runAgents(home, ['remove', `codex@${version}`]).status).toBe(0);
    expect(fs.existsSync(versionDir)).toBe(false);

    const result = runAgents(home, ['restore', `codex@${version}`]);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(combined).toContain(`Restored Codex@${version}`);
    // Version directory is back where it was, binary intact.
    expect(fs.existsSync(versionDir)).toBe(true);
    expect(fs.existsSync(path.join(versionDir, 'node_modules', '.bin', 'codex'))).toBe(true);
    // Trash entry for this version is emptied out after the move.
    const trashVersionDir = path.join(home, '.agents', '.history', 'trash', 'versions', 'codex', version);
    expect(fs.existsSync(trashVersionDir)).toBe(false);
  });

  it('exits non-zero when restoring a version that is not in trash', () => {
    const home = makeTempHome();
    tempHomes.push(home);

    const result = runAgents(home, ['restore', 'codex@9.9.9']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(combined).toContain('No trashed copy found for codex@9.9.9');
  });

  it('does not hard-delete trash entries through cleanup', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    const trashEntry = path.join(home, '.agents', '.history', 'trash', 'versions', 'grok', '1.0.0', 'old-stamp');
    const homeFile = path.join(trashEntry, 'home', '.grok', 'session.jsonl');
    fs.mkdirSync(path.dirname(homeFile), { recursive: true });
    fs.writeFileSync(homeFile, '{"type":"user"}\n');
    fs.utimesSync(trashEntry, new Date('2024-01-01T00:00:00.000Z'), new Date('2024-01-01T00:00:00.000Z'));

    const result = runAgents(home, ['prune', 'cleanup', 'trash', '--older-than', '0', '-y']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(combined).toContain('Trash is durable');
    expect(fs.existsSync(homeFile)).toBe(true);
  });

  it('does not hard-delete session rows through cleanup', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    const sessionId = 'durable-session-row';
    const filePath = path.join(home, '.agents', '.history', 'trash', 'versions', 'antigravity', '1.0.0', 'stamp', 'home', '.gemini', 'antigravity-cli', 'session.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"type":"user"}\n');
    seedSessionRow(home, sessionId, 'antigravity', '1.0.0', filePath);

    const result = runAgents(home, ['prune', 'cleanup', 'sessions', '--older-than', '0', '-y']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(combined).toContain('Session history is durable');
    expect(readSessionFilePath(home, sessionId)).toBe(filePath);
  });

  it('syncs central commands with --names in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'demo');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'demo', '--agents', 'codex']);
    const targetPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'demo.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it('syncs only the requested explicit version target', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'demo');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    writeFakeManagedVersion(home, 'codex', '0.2.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'demo', '--agents', 'codex@0.2.0']);
    const requestedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.2.0',
      'home',
      '.codex',
      'prompts',
      'demo.md',
    );
    const untouchedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'demo.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(requestedPath)).toBe(true);
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('uses defaults automatically for version switching in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'demo');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['use', 'codex@0.1.0']);
    const agentsYaml = fs.readFileSync(devicePinsPath(home), 'utf-8');
    const codexSymlink = path.join(home, '.codex');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Set Codex@0.1.0 as global default');
    expect(agentsYaml).toContain('"codex": "0.1.0"');
    expect(fs.lstatSync(codexSymlink).isSymbolicLink()).toBe(true);
  });

  it('`use` on an isolated install sets the ISOLATED default and never repoints the real config', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    // Mark it isolated the way `agents add --isolated` does: a `.isolated` marker
    // in the version dir. `use` records which isolated copy a bare `agents run
    // codex` should reach — it must NOT repoint the real ~/.codex at (or carry
    // settings into) an isolated home, nor pin it as the global default.
    fs.writeFileSync(
      path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', '.isolated'),
      '',
    );

    const result = runAgents(home, ['use', 'codex@0.1.0']);
    const codexSymlink = path.join(home, '.codex');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('default ISOLATED copy');
    // The isolation guarantee, unchanged: the real ~/.codex is never created or
    // repointed...
    expect(fs.existsSync(codexSymlink)).toBe(false);
    // ...and the pointer is recorded under `isolatedAgents:`, never as a global
    // `agents:` pin — the separation that keeps getGlobalDefault unable to return
    // an isolated version.
    const pins = fs.readFileSync(devicePinsPath(home), 'utf-8');
    expect(pins).toContain('isolatedAgents');
    expect(pins).not.toMatch(/"agents"\s*:\s*\{[^}]*"codex"/);
  });

  it('blocks `agents add gemini` before installation or resource sync', () => {
    const home = makeTempHome();
    tempHomes.push(home);

    const result = runAgents(home, ['add', 'gemini@latest', '-y']);
    const geminiVersionsDir = path.join(home, '.agents', '.history', 'versions', 'gemini');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Gemini is no longer supported by agents-cli');
    expect(result.stderr).toContain('Use Antigravity instead:  agents add antigravity');
    expect(fs.existsSync(geminiVersionsDir)).toBe(false);
  });

  it('pins the one managed installation on explicit @release instead of creating a second home (PHNX-3940)', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: 0.1.0\n');
    const fakeNpmBin = writeFakeNpmInstaller(home, '0.2.0');

    const result = runAgents(home, ['add', 'codex@0.2.0', '-y'], {
      PATH: `${fakeNpmBin}${path.delimiter}${process.env.PATH || ''}`,
    });
    const agentsYaml = fs.readFileSync(devicePinsPath(home), 'utf-8');
    const versionsDir = path.join(home, '.agents', '.history', 'versions', 'codex');
    const record = JSON.parse(
      fs.readFileSync(path.join(versionsDir, '0.1.0', 'installation.json'), 'utf-8'),
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // No second home: the managed install itself moved to the pinned release…
    expect(fs.readdirSync(versionsDir)).toEqual(['0.1.0']);
    expect(record.releaseVersion).toBe('0.2.0');
    expect(record.updatePolicy).toBe('pinned');
    expect(fs.existsSync(path.join(versionsDir, '0.1.0', 'node_modules', '.bin', 'codex'))).toBe(true);
    // …and the default pointer never moved.
    expect(agentsYaml).toContain('"codex": "0.1.0"');
    expect(result.stdout).toContain("agents update codex --to 0.2.0");
    expect(result.stdout).toContain('--isolated');
  });

  it('creates a second home only with --isolated, leaving the default untouched', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: 0.1.0\n');
    const fakeNpmBin = writeFakeNpmInstaller(home, '0.2.0');

    const result = runAgents(home, ['add', 'codex@0.2.0', '--isolated', '-y'], {
      PATH: `${fakeNpmBin}${path.delimiter}${process.env.PATH || ''}`,
    });
    const agentsYaml = fs.readFileSync(devicePinsPath(home), 'utf-8');
    const versionsDir = path.join(home, '.agents', '.history', 'versions', 'codex');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readdirSync(versionsDir).sort()).toEqual(['0.1.0', '0.2.0']);
    expect(fs.existsSync(path.join(versionsDir, '0.2.0', '.isolated'))).toBe(true);
    expect(agentsYaml).toContain('"codex": "0.1.0"');
  });

  it('installs package repo contents only to the requested explicit version target', () => {
    const home = makeTempHome();
    const repo = writeLocalPackageRepo();
    tempHomes.push(home);
    tempRepos.push(repo);
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    writeFakeManagedVersion(home, 'codex', '0.2.0', 'codex');

    const result = runAgents(home, ['install', repo, '--agents', 'codex@0.2.0']);
    const requestedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.2.0',
      'home',
      '.codex',
      'prompts',
      'review.md',
    );
    const untouchedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'review.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Package installed.');
    expect(fs.existsSync(requestedPath)).toBe(true);
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('registers MCPs only against the requested explicit version target', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-register.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.1.0', 'codex', logPath);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    const addResult = runAgents(home, ['mcp', 'add', 'demo', '--agents', 'codex@0.2.0', '--', 'demo-server']);
    const registerResult = runAgents(home, ['sync', '--mcp', 'demo', '--yes']);
    const manifest = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(addResult.status).toBe(0);
    expect(registerResult.status).toBe(0);
    expect(manifest).toContain('mcp:');
    expect(manifest).toContain('demo:');
    expect(manifest).toContain('codex:');
    expect(manifest).toContain('- 0.2.0');
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp add demo -- demo-server');
    expect(log).not.toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home'));
  });

  it('registers HTTP MCPs from the manifest to Codex with --url', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-http-register.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    const addResult = runAgents(home, [
      'mcp',
      'add',
      'docs',
      'https://developers.openai.com/mcp',
      '--transport',
      'http',
      '--agents',
      'codex@0.2.0',
    ]);
    const registerResult = runAgents(home, ['sync', '--mcp', 'docs', '--yes']);
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(addResult.status).toBe(0);
    expect(registerResult.status, `${registerResult.stdout}\n${registerResult.stderr}`).toBe(0);
    expect(registerResult.stdout).not.toContain('HTTP transport not yet supported');
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp add docs --url https://developers.openai.com/mcp');
  });

  it('umbrella sync --local reconciles HTTP MCPs from the manifest to Codex with --url', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-http-reconcile.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    const addResult = runAgents(home, [
      'mcp',
      'add',
      'docs',
      'https://developers.openai.com/mcp',
      '--transport',
      'http',
      '--agents',
      'codex@0.2.0',
    ]);
    expect(addResult.status).toBe(0);
    // Only the reconcile stage's calls count: bare `agents sync` reaches MCP
    // registration through refresh(), which skipped every HTTP server.
    fs.writeFileSync(logPath, '');

    const syncResult = runAgents(home, ['sync', '--local', '--yes']);
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(syncResult.status, `${syncResult.stdout}\n${syncResult.stderr}`).toBe(0);
    expect(syncResult.stdout).toContain('docs -> Codex@0.2.0');
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp add docs --url https://developers.openai.com/mcp');
  });

  it('removes MCPs only from the requested explicit version target', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-remove.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.1.0', 'codex', logPath);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    // Pre-register 'demo' in codex 0.2.0's MCP config so mcp remove can find it.
    const versionHome02 = path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home');
    const codexConfigDir = path.join(versionHome02, '.codex');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexConfigDir, 'config.toml'),
      '[mcp_servers]\n[mcp_servers.demo]\ncommand = "demo-server"\nargs = []\n',
    );

    const result = runAgents(home, ['mcp', 'remove', 'demo', '--agents', 'codex@0.2.0']);
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(result.status).toBe(0);
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp remove demo');
    expect(log).not.toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home'));
  });

  it('AGENTS_CLI_DISABLE_AUTO_UPDATE skips the update check when a newer version is cached', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    seedNewerUpdateCache(home, '99.0.0');

    const result = runAgents(home, ['view'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(combined).not.toContain('Update available');
  });

  it('prints the non-TTY hint (not an interactive picker) when a newer version is cached', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    seedNewerUpdateCache(home, '99.0.0');

    // tsx src/index.ts trips the dev-build auto-detect (.git at repo root)
    // and disables the update prompt by default. This test verifies the
    // update prompt itself, so override the auto-detect with an explicit
    // empty env var (falsy — doesn't trip the disable guard, doesn't
    // satisfy the "undefined" check in src/index.ts that would re-set it).
    const result = runAgents(home, ['view'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(combined).toContain(`Update available: ${PACKAGE_VERSION.version} -> 99.0.0`);
    expect(combined).not.toContain('Upgrade now');
  });

  it('renders each custom harness as its own agent-type block in `agents view`', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'claude', '2.1.143', 'claude');
    writeFakeManagedVersion(home, 'codex', '0.134.0', 'codex');
    writeProfileYaml(home, 'test-proxy', {
      agent: 'claude',
      provider: 'truefoundry',
      env: { ANTHROPIC_MODEL: 'truefoundry/qwen3-coder' },
    });
    writeProfileYaml(home, 'ollama', {
      agent: 'codex',
      provider: 'ollama',
      env: { OPENAI_MODEL: 'qwen3-coder:30b' },
    });

    const result = runAgents(home, ['view'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status, combined).toBe(0);
    // No separate "Profiles" section header — a harness gets a name header of
    // its own, exactly like Claude/Codex above it.
    expect(combined).not.toMatch(/^Profiles\s*$/m);
    // The header is derived from the harness name via the vendor/brand table:
    // 'test-proxy' -> 'Test Proxy', 'ollama' -> 'Ollama'.
    expect(combined).toMatch(/^ {2}Test Proxy \(custom\)$/m);
    expect(combined).toMatch(/^ {2}Ollama \(custom\)$/m);
    // The model + the host that executes it sit on the harness's own row.
    expect(combined).toMatch(/truefoundry\/qwen3-coder\s.*forked from claude/);
    expect(combined).toMatch(/qwen3-coder:30b\s.*forked from codex/);
  }, 30_000);

  it('describes a custom harness in `agents view <harness>` instead of rejecting the name', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'claude', '2.1.143', 'claude');
    writeProfileYaml(home, 'test-proxy', {
      agent: 'claude',
      provider: 'truefoundry',
      env: { ANTHROPIC_MODEL: 'truefoundry/qwen3-coder' },
    });

    const result = runAgents(home, ['view', 'test-proxy'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status, combined).toBe(0);
    expect(combined).toContain('custom harness');
    expect(combined).toContain('truefoundry/qwen3-coder');
    expect(combined).toContain('agents run test-proxy');
  }, 30_000);

  it('keeps custom harnesses out of a native-specific `agents view claude`', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'claude', '2.1.143', 'claude');
    writeFakeManagedVersion(home, 'codex', '0.134.0', 'codex');
    writeProfileYaml(home, 'test-proxy', {
      agent: 'claude',
      env: { ANTHROPIC_MODEL: 'truefoundry/qwen3-coder' },
    });
    writeProfileYaml(home, 'ollama', {
      agent: 'codex',
      env: { OPENAI_MODEL: 'qwen3-coder:30b' },
    });

    const result = runAgents(home, ['view', 'claude'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status, combined).toBe(0);
    expect(combined).not.toContain('test-proxy');
    expect(combined).not.toContain('ollama');
  }, 30_000);

  it('does not attach custom harnesses to a native-specific `agents view --json`', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'claude', '2.1.143', 'claude');
    writeProfileYaml(home, 'test-proxy', {
      agent: 'claude',
      provider: 'truefoundry',
      env: { ANTHROPIC_MODEL: 'truefoundry/qwen3-coder' },
    });

    const result = runAgents(home, ['view', 'claude', '--json'], {
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // `view <agent> --json` emits a single object, not an array.
    const claudeEntry = JSON.parse(result.stdout) as {
      agent: string;
      harnesses: Array<{ name: string; agent: string; model: string; provider: string }>;
    };
    expect(claudeEntry.agent).toBe('claude');
    expect(claudeEntry.harnesses).toEqual([]);
  }, 30_000);

  it('views an exact custom harness before a native harness with the same name', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeFakeManagedVersion(home, 'claude', '2.1.143', 'claude');
    writeProfileYaml(home, 'claude', {
      agent: 'opencode',
      provider: 'openrouter',
      env: { OPENCODE_MODEL: 'deepseek/deepseek-v3.2' },
    });

    const result = runAgents(home, ['view', 'claude'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status, combined).toBe(0);
    expect(combined).toContain('custom harness');
    expect(combined).toContain('Host:     opencode');
    expect(combined).toContain('deepseek/deepseek-v3.2');
    expect(combined).not.toContain('2.1.143');
  }, 30_000);

  it('sorts human view accounts by email after the default while keeping JSON version order', () => {
    const home = makeTempHome();
    tempHomes.push(home);

    const accounts = [
      { version: '2.1.400', email: null },
      { version: '2.1.300', email: 'beta@example.com' },
      { version: '2.1.200', email: 'Alpha@example.com' },
      { version: '2.1.100', email: 'zeta@example.com' },
    ];
    for (const { version, email } of accounts) {
      writeFakeManagedVersion(home, 'claude', version, 'claude');
      if (email) {
        const versionHome = path.join(
          home,
          '.agents',
          '.history',
          'versions',
          'claude',
          version,
          'home',
        );
        const configDir = path.join(versionHome, '.claude');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, '.claude.json'),
          JSON.stringify({ oauthAccount: { emailAddress: email } }),
        );
        // Off macOS, a missing `.credentials.json` is signed out even when
        // `.claude.json` still names an email (PHNX-2685). Seed a token so
        // the human view still has emails to sort by.
        fs.writeFileSync(
          path.join(configDir, '.credentials.json'),
          JSON.stringify({ claudeAiOauth: { accessToken: 'at-test', refreshToken: 'rt-test' } }),
        );
      }
    }
    fs.mkdirSync(path.dirname(devicePinsPath(home)), { recursive: true });
    fs.writeFileSync(devicePinsPath(home), JSON.stringify({ agents: { claude: '2.1.100' } }, null, 2) + '\n');

    const human = runAgents(home, ['view', 'claude', '--versions'], {
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      FORCE_COLOR: '0',
    });
    expect(human.status, `${human.stdout}\n${human.stderr}`).toBe(0);
    const humanRows = human.stdout
      .split('\n')
      .filter((line) => line.includes('@example.com') || line.includes('(logged out'));
    expect(humanRows.map((line) => line.match(/2\.1\.\d+/)?.[0])).toEqual([
      '2.1.100',
      '2.1.200',
      '2.1.300',
      '2.1.400',
    ]);

    const json = runAgents(home, ['view', 'claude', '--json'], {
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
    });
    expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
    const payload = JSON.parse(json.stdout) as { versions: Array<{ version: string }> };
    expect(payload.versions.map(({ version }) => version)).toEqual([
      '2.1.100',
      '2.1.400',
      '2.1.300',
      '2.1.200',
    ]);
  }, 30_000);
});
