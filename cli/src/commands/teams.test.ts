import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildTeamRowsFromSnapshots, printFeedHint, type TeamListAgentSnapshot } from './teams.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

function guardedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-teams-home-'));
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  testHome = home;
  return home;
}

function seedTeam(home: string, teamName: string, agents: TeamListAgentSnapshot[]): void {
  const history = path.join(home, '.agents', '.history', 'teams');
  fs.mkdirSync(path.join(history, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(history, 'registry.json'),
    JSON.stringify({ [teamName]: { created_at: '2026-08-01T12:00:00.000Z' } }, null, 2),
  );
  for (const agent of agents) {
    const agentDir = path.join(history, 'agents', agent.agent_id);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({
        agent_id: agent.agent_id,
        task_name: agent.task_name,
        agent_type: agent.agent_type,
        status: agent.status,
        prompt: agent.prompt,
        started_at: agent.started_at,
        completed_at: agent.completed_at,
        workspace_dir: agent.workspace_dir,
        version: agent.version,
        remote_session_id: agent.remote_session_id,
        name: agent.name,
        after: agent.after,
        task_type: agent.task_type,
        host_name: agent.host,
        mode: agent.mode,
        cloud_session_id: agent.cloud_session_id,
        cloud_provider: agent.cloud_provider,
        pr_url: agent.pr_url,
        remote_pid: 424242,
        remote_log: '$HOME/.agents/.cache/hosts/offline.log',
        remote_exit: '$HOME/.agents/.cache/hosts/offline.exit',
        host_target: '203.0.113.1',
      }, null, 2),
    );
  }
}

function remoteSnapshot(overrides: Partial<TeamListAgentSnapshot> = {}): TeamListAgentSnapshot {
  return {
    agent_id: 'agent-remote-1',
    task_name: 'remote-lag',
    agent_type: 'codex',
    status: 'running',
    prompt: 'Investigate the remote failure',
    started_at: '2026-08-01T12:01:00.000Z',
    completed_at: null,
    workspace_dir: '/work/remote-lag',
    version: '0.146.0',
    remote_session_id: 'session-remote-1',
    name: 'remote',
    after: [],
    task_type: 'bugfix',
    host: 'offline-box',
    mode: 'edit',
    cloud_session_id: null,
    cloud_provider: null,
    pr_url: null,
    ...overrides,
  };
}

function run(
  args: string[],
  setup?: (home: string) => void,
  timeout = 10_000,
): { stdout: string; stderr: string; status: number | null; error?: Error; home: string } {
  const home = guardedHome();
  setup?.(home);
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    timeout,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_EVENTS_PATH: path.join(home, '.agents', 'events.jsonl'),
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, error: r.error, home };
}

describe('teams list output modes', () => {
  it('keeps piped stdout human-readable unless --json is passed', () => {
    const { stdout, status } = run(['teams', 'list']);
    expect(status).toBe(0);
    expect(stdout).toContain("You haven't started any teams yet.");
    expect(() => JSON.parse(stdout)).toThrow();
  });

  it('emits JSON when --json is passed', () => {
    const { stdout, status } = run(['teams', 'list', '--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ teams: [] });
  });

  it('builds list rows from cached teammate metadata', async () => {
    const result = await buildTeamRowsFromSnapshots(
      { 'remote-lag': { created_at: '2026-08-01T12:00:00.000Z', description: 'remote work' } },
      [remoteSnapshot()],
    );

    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]).toMatchObject({
      task_name: 'remote-lag',
      agent_count: 1,
      running: 1,
      workspace_dir: '/work/remote-lag',
    });
    expect(result.rows[0].agents[0]).toMatchObject({
      agent_id: 'agent-remote-1',
      agent_type: 'codex',
      host: 'offline-box',
      tool_count: 0,
      files_modified: [],
    });
  });

  it.skipIf(process.platform === 'win32')('does not probe unreachable remote teammates for JSON list output', () => {
    const { stdout, status, error } = run(
      ['teams', 'list', '--json'],
      (home) => seedTeam(home, 'remote-lag', [remoteSnapshot()]),
      2_500,
    );

    expect(error).toBeUndefined();
    expect(status).toBe(0);
    expect(JSON.parse(stdout).teams[0]).toMatchObject({
      task_name: 'remote-lag',
      agent_count: 1,
      running: 1,
    });
  });

  it('emits a friction event when teams add --remote-cwd is rejected', () => {
    const { status, home } = run(['teams', 'add', 't1', 'claude', 'task', '--remote-cwd', '/tmp/x']);

    expect(status).toBe(1);
    const eventsPath = path.join(home, '.agents', 'events.jsonl');
    expect(fs.existsSync(eventsPath)).toBe(true);
    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const friction = lines.map((l) => JSON.parse(l)).find((r) => r.event === 'friction');
    expect(friction).toBeDefined();
    expect(friction.surface).toBe('teams');
    expect(friction.failureId).toBe('remote-cwd-on-add');
    expect(friction.error).toContain('--remote-cwd');
  });
});

describe('printFeedHint', () => {
  it('points milestones at the feed and team progress at teams status', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
    try {
      printFeedHint('pricing-page');
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    expect(out).toContain('agents feed timeline');
    expect(out).toContain('agents teams status pricing-page');
    expect(out).toContain('IMPORTANT milestones');
  });
});

describe('buildTeamRowsFromSnapshots stranded detection (PHNX-2951)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createDirtyWorktree(): { worktreePath: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-list-stranded-'));
    tempDirs.push(repoRoot);

    execFileSync('git', ['init'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

    const worktreePath = path.join(repoRoot, '.agents', 'worktrees', 'monitor-auth');
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'agents/monitor-auth', worktreePath],
      { cwd: repoRoot },
    );
    fs.writeFileSync(path.join(worktreePath, 'fix.ts'), 'export const fixed = true;\n');

    return { worktreePath };
  }

  it('counts a completed no-PR teammate with a dirty worktree as stranded', async () => {
    const { worktreePath } = createDirtyWorktree();
    const result = await buildTeamRowsFromSnapshots(
      { 'bugfix-swarm': { created_at: '2026-08-20T12:00:00.000Z' } },
      [
        remoteSnapshot({
          agent_id: 'agent-stranded-1',
          task_name: 'bugfix-swarm',
          agent_type: 'cursor',
          status: 'completed',
          host: null,
          pr_url: null,
          workspace_dir: worktreePath,
          completed_at: '2026-08-20T12:33:00.000Z',
        }),
      ],
    );

    expect(result.teams[0]).toMatchObject({
      task_name: 'bugfix-swarm',
      agent_count: 1,
      completed: 1,
      stranded: 1,
    });
    expect(result.rows[0].agents[0].delivery).toBe('stranded');
    expect(result.rows[0].agents[0].workspace_dir).toBe(worktreePath);
  });
});
