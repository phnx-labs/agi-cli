/** PHNX-3940: `agents update --check` is a read-only preview and must not run mutating startup
 * steps (migration, device-config fold, sync). Spawns the real CLI with suppression flags OFF
 * (AGENTS_SKIP_MIGRATION=0), else dev-build detection hides the bug; `--auto` must still migrate. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, '../../..');
const INDEX = path.join(CLI_ROOT, 'src/index.ts');

let scratch: string;

afterEach(() => {
  if (scratch && fs.existsSync(scratch)) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/** Paths inside a fixture HOME, mirroring src/lib/state.ts. */
function paths(home: string) {
  const agents = path.join(home, '.agents');
  return {
    agents,
    central: path.join(agents, 'agents.yaml'),
    migratedSentinel: path.join(agents, '.cache', '.migrated'),
    updateCheckCache: path.join(agents, '.cache', '.update-check'),
    oldboxDoc: path.join(agents, 'devices', 'oldbox', 'agents.yaml'),
    installation: (agent: string, label: string) =>
      path.join(agents, '.history', 'versions', agent, label, 'installation.json'),
  };
}

/** Build a fixture HOME: a system repo (so `ensureInitialized` does not prompt), one claude and one
 * codex install, `updates.auto=false` (no network target), and a legacy
 * `fleet.devices.oldbox.config` store that the device-config migration would fold into */
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-check-ro-'));
  const home = path.join(dir, 'home');
  const p = paths(home);
  // System repo present → ensureInitialized is a no-op read.
  fs.mkdirSync(path.join(p.agents, '.system', '.git'), { recursive: true });
  // Central config: kill switch off (no network), plus the legacy device store.
  fs.writeFileSync(
    p.central,
    'agents: {}\n' +
      'config:\n' +
      '  updatesAuto: false\n' +
      'fleet:\n' +
      '  devices:\n' +
      '    oldbox:\n' +
      '      config:\n' +
      '        maxAgents: 7\n',
  );
  writeInstallation(home, 'claude', '2.0.65');
  writeInstallation(home, 'codex', '0.30.0');
  return home;
}

function writeInstallation(home: string, agent: string, label: string): void {
  const file = paths(home).installation(agent, label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schema: 1,
        id: `ins_${agent}${label.replace(/\W/g, '')}`,
        agent,
        label,
        releaseVersion: label,
        createdAt: now,
        updatedAt: now,
        history: [{ releaseVersion: label, at: now }],
        updatePolicy: 'latest',
      },
      null,
      2,
    )}\n`,
  );
}

function runCli(args: string[], home: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', INDEX, ...args], {
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // Suppression flags explicitly OFF — otherwise the dev-build detector sets
      // them to '1' and the migration/sync/auto-update never run, so a
      // regression in the read-only gate would be invisible.
      AGENTS_SKIP_MIGRATION: '0',
      AGENTS_NO_AUTOPULL: '0',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '0',
      NODE_NO_WARNINGS: '1',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('agents update --check is read-only at the bootstrap boundary (PHNX-3940)', () => {
  it('bare --check previews the plan and writes nothing to disk', () => {
    const home = makeFixture();
    scratch = path.dirname(home);
    const p = paths(home);
    const beforeClaude = fs.readFileSync(p.installation('claude', '2.0.65'), 'utf-8');
    const beforeCentral = fs.readFileSync(p.central, 'utf-8');

    const { status, stdout, stderr } = runCli(['update', '--check'], home);
    // The plan renders (installations exist, kill switch off → "not eligible").
    expect(status, `stderr:\n${stderr}`).toBe(0);
    expect(stdout).toMatch(/Automatic-update plan/);

    // No migration ran: sentinel absent, legacy device store un-folded, central
    // unchanged, and the update-check cache never written.
    expect(fs.existsSync(p.migratedSentinel), 'migration sentinel must not be written on --check').toBe(false);
    expect(fs.existsSync(p.oldboxDoc), 'legacy device store must not be folded on --check').toBe(false);
    expect(fs.readFileSync(p.central, 'utf-8')).toBe(beforeCentral);
    expect(fs.existsSync(p.updateCheckCache), 'auto-update cache must not be written on --check').toBe(false);
    // The planner read the installation, never rewrote it.
    expect(fs.readFileSync(p.installation('claude', '2.0.65'), 'utf-8')).toBe(beforeClaude);
  });

  it.each([{ prefix: [] }, { prefix: ['--verbose'] }])('a targeted preview with leading root flags $prefix is equally read-only', ({ prefix }) => {
    const home = makeFixture();
    scratch = path.dirname(home);
    const p = paths(home);
    const beforeCodex = fs.readFileSync(p.installation('codex', '0.30.0'), 'utf-8');

    const { status, stdout, stderr } = runCli([...prefix, 'update', 'codex', '--check'], home);
    expect(status, `stderr:\n${stderr}`).toBe(0);
    expect(stdout).toMatch(/codex/);

    expect(fs.existsSync(p.migratedSentinel)).toBe(false);
    expect(fs.existsSync(p.oldboxDoc)).toBe(false);
    expect(fs.readFileSync(p.installation('codex', '0.30.0'), 'utf-8')).toBe(beforeCodex);
  });

  it('preserves legacy meta.yaml when the central config has not been migrated', () => {
    const home = makeFixture();
    scratch = path.dirname(home);
    const p = paths(home);
    fs.unlinkSync(p.central);
    const legacy = path.join(p.agents, '.system', 'meta.yaml');
    const content = 'versions:\n  codex:\n    default: 0.30.0\n';
    fs.writeFileSync(legacy, content);
    for (const [agent, label] of [['claude', '2.0.65'], ['codex', '0.30.0']]) {
      const file = p.installation(agent, label);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...record, updatePolicy: 'pinned' }));
    }
    const { status, stderr } = runCli(['update', '--check'], home);
    expect(status, stderr).toBe(0);
    expect(fs.existsSync(p.central)).toBe(false);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(content);
  });

  it('a real `update --auto` over the SAME fixture DOES migrate — proving the exemption is specific to --check', () => {
    const home = makeFixture();
    scratch = path.dirname(home);
    const p = paths(home);

    // The control only proves the fixture is fold-able; suppress its background
    // network so the assertion on migration is not gated on registry reachability.
    const { status, stderr } = runCli(['update', '--auto'], home, {
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
    });
    // updates.auto=false → nothing eligible → clean exit, but the bootstrap
    // migration still ran ahead of the action.
    expect(status, `stderr:\n${stderr}`).toBe(0);
    expect(fs.existsSync(p.migratedSentinel), 'a non-check command writes the migration sentinel').toBe(true);
    expect(fs.existsSync(p.oldboxDoc), 'a non-check command folds the legacy device store').toBe(true);
  });
});
