/** Semantic team-lifecycle audit events: `teams.create`/`teams.disband` are emitted at the registry
 * source (createTeam/ensureTeam/removeTeam), so they fire for every path and only on a real
 * mutation. Driven through the real CLI under a temp HOME; no mocking. */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string }).version;

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-teamsev-'));
  tempHomes.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION }),
  );
  return home;
}

function runCli(home: string, args: string[]) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    // AGENTS_EVENTS_PATH is inherited from the hermetic fork default
    // (tests/setup.ts); blank it so the child resolves the canonical
    // HOME-derived log this suite asserts on ('' is falsy in the resolver).
    env: { ...process.env, HOME: home, SHELL: '/bin/zsh', SSH_CONNECTION: '', AGENTS_EVENTS_PATH: '' },
    encoding: 'utf-8',
  });
}

function readEvents(home: string): Array<Record<string, unknown>> {
  const eventsRoot = path.join(home, '.agents', '.history', 'events');
  if (!fs.existsSync(eventsRoot)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const day of fs.readdirSync(eventsRoot)) {
    const eventsPath = path.join(eventsRoot, day, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) continue;
    for (const line of fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

afterEach(() => {
  for (const h of tempHomes.splice(0)) {
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('team lifecycle audit events', () => {
  it('emits teams.create (with metadata) and teams.disband for a real team', () => {
    const home = makeTempHome();
    runCli(home, ['teams', 'create', 'audit-team', '--enable-worktrees']);
    runCli(home, ['teams', 'disband', 'audit-team']);

    const events = readEvents(home);
    const create = events.filter((e) => e.event === 'teams.create' && e.team === 'audit-team');
    const disband = events.filter((e) => e.event === 'teams.disband' && e.team === 'audit-team');

    expect(create.length).toBe(1);
    expect(create[0].worktrees).toBe(true); // --enable-worktrees captured in payload
    expect(create[0].module).toBe('teams'); // so `--module teams` surfaces it
    expect(disband.length).toBe(1);
    // Attribution rides along like every other event.
    expect(typeof create[0].osUser).toBe('string');
    expect(create[0].transport).toBe('local');

    // The advertised `--module teams` filter must catch the semantic events,
    // not just the generic command.* pair.
    const byModule = JSON.parse(
      runCli(home, ['events', '--module', 'teams', '--event', 'teams.create', '--json']).stdout,
    ) as Array<Record<string, unknown>>;
    expect(byModule.some((e) => e.event === 'teams.create' && e.team === 'audit-team')).toBe(true);
  });

  it('does NOT emit teams.disband when the team does not exist', () => {
    const home = makeTempHome();
    const res = runCli(home, ['teams', 'disband', 'never-existed', '--json']);
    // The command reports existed:false (no real removal), so no semantic
    // teams.disband event fires — only the generic command.* pair.
    expect(res.stdout).toContain('"existed": false');
    expect(readEvents(home).some((e) => e.event === 'teams.disband')).toBe(false);
  });

  it('does NOT emit a second teams.create when create fails on a duplicate', () => {
    const home = makeTempHome();
    runCli(home, ['teams', 'create', 'dup-team']);
    const second = runCli(home, ['teams', 'create', 'dup-team']); // already exists → error
    expect(second.status).not.toBe(0);

    const creates = readEvents(home).filter((e) => e.event === 'teams.create' && e.team === 'dup-team');
    expect(creates.length).toBe(1); // emit is post-commit, so the failed create logs nothing
  });
});
