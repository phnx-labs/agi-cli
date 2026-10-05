import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** Real-filesystem, real-CLI tests for `agents doctor --check`, the scriptable CI drift check
 * (issue #329). No mocks: drive the real `agents sync`, then assert the exit code. Clean exits 0;
 * drift exits non-zero (plain `agents doctor` returned 0 under drift, so CI could not gate). */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string;
let projectDir: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Build a temp HOME with an installed claude@2.0.0 and one source command. */
function seedHome(): { commandSrc: string } {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-check-home-'));
  // A separate, empty project dir so the project layer resolves to nothing —
  // both `sync` and `check` are pointed at it via --cwd so they see the same
  // (user-only) source set.
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-check-proj-'));

  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  // `.system/.git` keeps ensureInitialized() from blocking; `.update-check`
  // keeps the update probe from reaching the network.
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');

  // A fake installed version: a binary so listInstalledVersions() sees it.
  const binDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);

  // One user-layer source command.
  const commandsDir = path.join(userDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  const commandSrc = path.join(commandsDir, 'demo.md');
  fs.writeFileSync(commandSrc, '---\ndescription: demo\n---\n\n# demo\n');

  return { commandSrc };
}

/** Snapshot the manifest so the version reads as `fresh` (real sync, no mocks). */
function syncSnapshot(): void {
  execFileSync('bun', [INDEX, 'sync', 'claude@2.0.0', '-y', '--cwd', projectDir], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: testHome, AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices') },
    stdio: 'ignore',
  });
}

function runCheck(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [INDEX, 'doctor', '--check', '--cwd', projectDir, ...args], {
    cwd: REPO_ROOT,
    // AGENTS_NO_AUTOPULL keeps the detached background fetch from racing the
    // git-repo fixtures these tests build under HOME.
    env: { ...process.env, HOME: testHome, AGENTS_NO_AUTOPULL: '1', AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices') },
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runDoctorJson(): any {
  const r = spawnSync('bun', [INDEX, 'doctor', '--json', '--cwd', projectDir], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: testHome, AGENTS_NO_AUTOPULL: '1', AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices') },
    encoding: 'utf-8',
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

function seedVersionHook(version: string, content: string): void {
  const versionRoot = path.join(testHome, '.agents', '.history', 'versions', 'claude', version);
  const binDir = path.join(versionRoot, 'node_modules', '.bin');
  const hooksDir = path.join(versionRoot, 'home', '.claude', 'hooks');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, 'stop-gate.sh'), content, { mode: 0o755 });
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

describe('agents doctor --check — CI drift gate exit code', () => {
  it('reports identical same-name hooks across version homes and names the active authority', () => {
    seedHome();
    seedVersionHook('2.0.0', '#!/bin/sh\necho gate\n');
    seedVersionHook('2.1.0', '#!/bin/sh\necho gate\n');

    const report = runDoctorJson();
    const finding = report.duplicateHooks.find((item: any) => item.name === 'stop-gate');
    expect(finding.kind).toBe('duplicate');
    expect(finding.copies.map((copy: any) => copy.version)).toEqual(['2.0.0', '2.1.0']);
    expect(finding.authoritative.version).toBe('2.0.0');
    expect(report.health.issues.find((item: any) => item.category === 'duplicate-hook').severity).toBe('warning');
  });

  it('reports same-name hook content drift at higher severity', () => {
    seedHome();
    seedVersionHook('2.0.0', '#!/bin/sh\necho current\n');
    seedVersionHook('2.1.0', '#!/bin/sh\necho stale\n');

    const report = runDoctorJson();
    const finding = report.duplicateHooks.find((item: any) => item.name === 'stop-gate');
    expect(finding.kind).toBe('drift');
    expect(new Set(finding.copies.map((copy: any) => copy.hash)).size).toBe(2);
    expect(finding.authoritative.version).toBe('2.0.0');
    expect(report.health.issues.find((item: any) => item.category === 'duplicate-hook-drift').severity).toBe('critical');
  });

  it('exits 0 when the install is clean (synced, sources unchanged)', () => {
    seedHome();
    syncSnapshot();

    const r = runCheck();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('in sync');
  });

  it('exits non-zero when a source drifted since last sync', () => {
    const { commandSrc } = seedHome();
    syncSnapshot();
    // Change the SOURCE after the snapshot — the exact drift doctor detects but
    // never failed on.
    fs.writeFileSync(commandSrc, '---\ndescription: demo CHANGED\n---\n\n# demo v2\n');

    const r = runCheck();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('drift');
  });

  it('exits non-zero for a never-synced installed version (no manifest)', () => {
    seedHome();
    // No syncSnapshot() → no manifest → the version reads as never-synced.
    const r = runCheck();
    expect(r.status).not.toBe(0);
  });

  it('--json reports hasDrift and mirrors the exit code', () => {
    const { commandSrc } = seedHome();
    syncSnapshot();

    const clean = runCheck('--json');
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout).hasDrift).toBe(false);

    fs.writeFileSync(commandSrc, '---\ndescription: changed again\n---\n\n# v3\n');
    const drifted = runCheck('--json');
    expect(drifted.status).not.toBe(0);
    const parsed = JSON.parse(drifted.stdout);
    expect(parsed.hasDrift).toBe(true);
    expect(parsed.stale).toBe(1);
  });

  it('exits non-zero when a hook is present but unwired, with the version otherwise fresh', () => {
    // The yosemite-s1 blind spot: the drift check used computeDrift, which knew only manifest
    // staleness, so a present-but-unwired hook read as fresh and exited 0. This proves it now
    // fails, and only on the unwired signal (stale/never-synced/sourceBehind all zero).
    seedHome();
    syncSnapshot(); // 1st sync: the migrator runs here, clearing legacy agents.yaml

    // Post-migration, declare a user-layer hook (hooks-only, no `agents:` map so
    // the migrator stays quiet on the next sync) and its script.
    const userDir = path.join(testHome, '.agents');
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'hooks:\n  demo-guard:\n    script: demo-guard.sh\n    events: [PreToolUse]\n',
    );
    fs.mkdirSync(path.join(userDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'hooks', 'demo-guard.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    syncSnapshot(); // 2nd sync: snapshots WITH the hook (fresh) and wires settings.json
    expect(runCheck('--json').status).toBe(0); // clean: fresh AND wired

    // Now the exact bug state: keep the hook file, strip the settings.json wiring.
    const settings = path.join(
      userDir, '.history', 'versions', 'claude', '2.0.0', 'home', '.claude', 'settings.json',
    );
    const cfg = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    cfg.hooks = {};
    fs.writeFileSync(settings, JSON.stringify(cfg, null, 2));

    const r = runCheck('--json');
    expect(r.status).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hasDrift).toBe(true);
    expect(parsed.stale).toBe(0);
    expect(parsed.neverSynced).toBe(0);
    expect(parsed.unwiredHookVersions).toBe(1);
    const claude = parsed.versions.find((v: any) => v.agent === 'claude');
    expect(claude.status).toBe('fresh');
    expect(claude.unwiredHooks).toBe(1);
  });

  it('exits non-zero when a source layer is behind origin (repo pull heals it, not --fix)', () => {
    seedHome();
    syncSnapshot();
    expect(runCheck('--json').status).toBe(0); // clean before the source goes behind

    // Make ~/.agents a git repo one commit behind its upstream.
    const userDir = path.join(testHome, '.agents');
    const remote = path.join(testHome, 'user-remote.git');
    const other = path.join(testHome, 'user-other');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', userDir], { stdio: 'ignore' });
    git(userDir, 'config', 'user.email', 't@e.co');
    git(userDir, 'config', 'user.name', 'T');
    git(userDir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(userDir, '.ci-marker'), 'base\n');
    git(userDir, 'add', '.ci-marker');
    git(userDir, 'commit', '-m', 'base');
    git(userDir, 'remote', 'add', 'origin', remote);
    git(userDir, 'push', '-u', 'origin', 'main');
    // Advance the remote from a second clone, then fetch so ~/.agents trails it.
    execFileSync('git', ['clone', remote, other], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 't@e.co');
    git(other, 'config', 'user.name', 'T');
    git(other, 'config', 'commit.gpgsign', 'false');
    git(other, 'commit', '--allow-empty', '-m', 'ahead');
    git(other, 'push', 'origin', 'main');
    git(userDir, 'fetch', 'origin');

    const r = runCheck('--json');
    expect(r.status).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hasDrift).toBe(true);
    expect(parsed.sourceBehind.some((s: any) => s.layer === 'user' && s.behind >= 1)).toBe(true);
  });

  it('--devices exits non-zero when any registered device is unreachable', () => {
    seedHome();
    const registryDir = path.join(testHome, '.agents', '.history', 'devices');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      deadbox: {
        name: 'deadbox',
        platform: 'linux',
        shell: 'posix',
        user: 'muqsit',
        address: { via: 'manual', dnsName: 'deadbox.example.invalid' },
        auth: { method: 'key' },
        tailscale: { online: false, direct: false, lastSeen: '2026-07-17T00:00:00.000Z' },
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    }, null, 2));

    const r = runCheck('--devices', '--json');
    expect(r.status).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hasDrift).toBe(true);
    expect(parsed.devices.some((d: any) => d.device === 'deadbox' && d.error === 'offline')).toBe(true);
  });
});
