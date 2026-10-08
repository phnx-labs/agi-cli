import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome: string;
let systemDir: string;
let userDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  systemDir = path.join(testHome, '.agents-system');
  userDir = path.join(testHome, '.agents');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

function runRealMigration(): void {
  const modulePath = path.resolve(process.cwd(), 'src/lib/installations/migrate.ts');
  execFileSync(
    'bun',
    ['-e', `import { runMigration } from ${JSON.stringify(modulePath)}; await runMigration();`],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: testHome, AGENTS_SYNC_MACHINE_ID: 'testdev' },
      stdio: 'pipe',
    },
  );
}

function devicePinsFile(): string {
  return path.join(userDir, '.history', 'devices', 'pins-testdev.json');
}

describe('runMigration', () => {
  it('renames the legacy favorites store to bookmarks without losing ids', () => {
    const historyDir = path.join(userDir, '.history');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'favorites.json'), JSON.stringify({
      version: 1,
      sessionIds: ['session-a', 'session-b'],
    }));

    runRealMigration();

    expect(JSON.parse(fs.readFileSync(path.join(historyDir, 'bookmarks.json'), 'utf-8'))).toEqual({
      version: 1,
      sessionIds: ['session-a', 'session-b'],
    });
    expect(fs.existsSync(path.join(historyDir, 'favorites.json'))).toBe(false);
  });

  it('keeps the canonical bookmarks store when both marker stores exist', () => {
    const historyDir = path.join(userDir, '.history');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'favorites.json'), JSON.stringify({ version: 1, sessionIds: ['legacy'] }));
    fs.writeFileSync(path.join(historyDir, 'bookmarks.json'), JSON.stringify({ version: 1, sessionIds: ['canonical'] }));

    runRealMigration();

    expect(JSON.parse(fs.readFileSync(path.join(historyDir, 'bookmarks.json'), 'utf-8'))).toEqual({
      version: 1,
      sessionIds: ['canonical'],
    });
    expect(fs.existsSync(path.join(historyDir, 'favorites.json'))).toBe(false);
  });

  it('moves legacy files into the user repo and deletes dead files', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'agents:\n  claude: "1.0.0"\n');
    fs.writeFileSync(path.join(systemDir, 'prompts.json'), '{}');
    fs.writeFileSync(path.join(systemDir, 'config.json'), '{"version":1}');
    fs.writeFileSync(path.join(systemDir, 'promptcuts.yaml'), 'system: true\n');
    fs.writeFileSync(path.join(userDir, 'promptcuts.yaml'), 'user: true\n');

    runRealMigration();

    expect(fs.readFileSync(devicePinsFile(), 'utf-8')).toContain('claude');
    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(systemDir, 'prompts.json'))).toBe(false);
    expect(fs.existsSync(path.join(systemDir, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(userDir, 'teams', 'config.json'))).toBe(false);
    expect(fs.readFileSync(path.join(systemDir, 'hooks', 'promptcuts.yaml'), 'utf-8')).toBe('system: true\n');
    expect(fs.readFileSync(path.join(userDir, 'hooks', 'promptcuts.yaml'), 'utf-8')).toBe('user: true\n');
    expect(fs.existsSync(path.join(systemDir, 'promptcuts.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(userDir, 'promptcuts.yaml'))).toBe(false);
  });

  it('is idempotent and preserves existing destination files', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'system agents');
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'user agents');

    runRealMigration();
    runRealMigration();

    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toBe('user agents');
    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(false);
  });

  it('moves ~/.agents-system/versions/<agent>/<ver>/ into ~/.agents/versions/ and merges overlap', () => {
    const orphanSys = path.join(systemDir, 'versions', 'claude', '2.0.99', 'home', '.claude');
    fs.mkdirSync(orphanSys, { recursive: true });
    fs.writeFileSync(path.join(orphanSys, '.credentials.json'), '{"oauth":{"email":"test@example.com"}}');

    const userOverlap = path.join(userDir, 'versions', 'claude', '2.0.50', 'home', '.claude');
    fs.mkdirSync(path.join(userOverlap, 'skills', 'mq'), { recursive: true });
    fs.writeFileSync(path.join(userOverlap, 'skills', 'mq', 'SKILL.md'), 'fresh-from-sync');
    const sysOverlap = path.join(systemDir, 'versions', 'claude', '2.0.50', 'home', '.claude');
    fs.mkdirSync(sysOverlap, { recursive: true });
    fs.writeFileSync(path.join(sysOverlap, 'history.jsonl'), 'legacy-history');
    fs.writeFileSync(path.join(sysOverlap, 'skills-stale.md'), 'stale');

    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: 2.0.50\n');
    const symlinkPath = path.join(testHome, '.claude');
    fs.symlinkSync(sysOverlap, symlinkPath);

    runRealMigration();

    const historyDir = path.join(userDir, '.history');
    const newUserOverlap = path.join(historyDir, 'versions', 'claude', '2.0.50', 'home', '.claude');

    expect(fs.existsSync(path.join(historyDir, 'versions', 'claude', '2.0.99', 'home', '.claude', '.credentials.json'))).toBe(true);
    expect(fs.existsSync(path.join(systemDir, 'versions', 'claude', '2.0.99'))).toBe(false);

    expect(fs.readFileSync(path.join(newUserOverlap, 'skills', 'mq', 'SKILL.md'), 'utf-8')).toBe('fresh-from-sync');
    expect(fs.readFileSync(path.join(newUserOverlap, 'history.jsonl'), 'utf-8')).toBe('legacy-history');

    const trashRoot = path.join(historyDir, 'trash', 'versions', 'claude', '2.0.50');
    expect(fs.existsSync(trashRoot)).toBe(true);

    const newTarget = fs.readlinkSync(symlinkPath);
    expect(path.resolve(path.dirname(symlinkPath), newTarget)).toBe(path.resolve(newUserOverlap));
  });

  describe('migratePermissionSetsToPresets', () => {
    it('renames permissions/sets/ to permissions/presets/ in user dir', () => {
      const setsDir = path.join(userDir, 'permissions', 'sets');
      fs.mkdirSync(setsDir, { recursive: true });
      fs.writeFileSync(path.join(setsDir, 'sandbox.yaml'), 'name: sandbox\nincludes: [base]');

      runRealMigration();

      const presetsDir = path.join(userDir, 'permissions', 'presets');
      expect(fs.existsSync(presetsDir)).toBe(true);
      expect(fs.existsSync(setsDir)).toBe(false);
      expect(fs.readFileSync(path.join(presetsDir, 'sandbox.yaml'), 'utf-8')).toBe('name: sandbox\nincludes: [base]');
    });

    it('renames permissions/sets/ to permissions/presets/ in system dir', () => {
      const setsDir = path.join(systemDir, 'permissions', 'sets');
      fs.mkdirSync(setsDir, { recursive: true });
      fs.writeFileSync(path.join(setsDir, 'minimal.yaml'), 'name: minimal\nincludes: []');

      runRealMigration();

      const presetsDir = path.join(systemDir, 'permissions', 'presets');
      expect(fs.existsSync(presetsDir)).toBe(true);
      expect(fs.existsSync(setsDir)).toBe(false);
      expect(fs.readFileSync(path.join(presetsDir, 'minimal.yaml'), 'utf-8')).toBe('name: minimal\nincludes: []');
    });

    it('skips if presets/ already exists (idempotent)', () => {
      const setsDir = path.join(userDir, 'permissions', 'sets');
      const presetsDir = path.join(userDir, 'permissions', 'presets');
      fs.mkdirSync(setsDir, { recursive: true });
      fs.mkdirSync(presetsDir, { recursive: true });
      fs.writeFileSync(path.join(setsDir, 'old.yaml'), 'old');
      fs.writeFileSync(path.join(presetsDir, 'new.yaml'), 'new');

      runRealMigration();
      runRealMigration();

      expect(fs.existsSync(setsDir)).toBe(true);
      expect(fs.readFileSync(path.join(setsDir, 'old.yaml'), 'utf-8')).toBe('old');
      expect(fs.readFileSync(path.join(presetsDir, 'new.yaml'), 'utf-8')).toBe('new');
    });

    it('handles both user and system dirs together', () => {
      const userSets = path.join(userDir, 'permissions', 'sets');
      const sysSets = path.join(systemDir, 'permissions', 'sets');
      fs.mkdirSync(userSets, { recursive: true });
      fs.mkdirSync(sysSets, { recursive: true });
      fs.writeFileSync(path.join(userSets, 'user.yaml'), 'user preset');
      fs.writeFileSync(path.join(sysSets, 'system.yaml'), 'system preset');

      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'permissions', 'presets', 'user.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(systemDir, 'permissions', 'presets', 'system.yaml'))).toBe(true);
      expect(fs.existsSync(userSets)).toBe(false);
      expect(fs.existsSync(sysSets)).toBe(false);
    });

    it('no-op when sets/ does not exist', () => {
      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'permissions', 'presets'))).toBe(false);
      expect(fs.existsSync(path.join(systemDir, 'permissions', 'presets'))).toBe(false);
    });
  });

  describe('cleanup of orphan user-level files', () => {
    it('deletes ~/.agents/linear.json', () => {
      fs.writeFileSync(path.join(userDir, 'linear.json'), '{"apiKey":"lin_legacy"}');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'linear.json'))).toBe(false);
    });

    it('deletes ~/.agents/prompts.json', () => {
      fs.writeFileSync(path.join(userDir, 'prompts.json'), '[]');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'prompts.json'))).toBe(false);
    });

    it('removes empty ~/.agents/runs/ leftover dir', () => {
      fs.mkdirSync(path.join(userDir, 'runs'));
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'runs'))).toBe(false);
    });

    it('preserves ~/.agents/runs/ if it has contents (legacy not yet migrated)', () => {
      const runsDir = path.join(userDir, 'runs');
      fs.mkdirSync(path.join(runsDir, 'old-job'), { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'old-job', 'meta.json'), '{}');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, '.history', 'runs', 'old-job', 'meta.json'))).toBe(true);
      expect(fs.existsSync(runsDir)).toBe(false);
    });

    it('deletes legacy ~/.agents/config.json and ~/.agents/teams/config.json (no longer used)', () => {
      fs.writeFileSync(path.join(userDir, 'config.json'), '{"agents":{"claude":{"enabled":true}}}');
      fs.mkdirSync(path.join(userDir, 'teams'), { recursive: true });
      fs.writeFileSync(path.join(userDir, 'teams', 'config.json'), '{"canonical":true}');
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'config.json'))).toBe(false);
      expect(fs.existsSync(path.join(userDir, 'teams', 'config.json'))).toBe(false);
    });

    it('moves ~/.agents/teams/registry.json into .history/teams/', () => {
      fs.mkdirSync(path.join(userDir, 'teams'), { recursive: true });
      fs.writeFileSync(
        path.join(userDir, 'teams', 'registry.json'),
        '{"team-a":{"created_at":"2026-01-01T00:00:00Z"}}',
      );
      runRealMigration();
      expect(fs.existsSync(path.join(userDir, 'teams', 'registry.json'))).toBe(false);
      expect(fs.readFileSync(path.join(userDir, '.history', 'teams', 'registry.json'), 'utf-8'))
        .toBe('{"team-a":{"created_at":"2026-01-01T00:00:00Z"}}');
    });
  });

  describe('foldUserHooksYamlIntoAgentsYaml', () => {
    it('folds user hooks.yaml into agents.yaml hooks: section and deletes the standalone file', () => {
      fs.writeFileSync(
        path.join(userDir, 'agents.yaml'),
        'agents:\n  claude: 2.1.0\n',
      );
      fs.writeFileSync(
        path.join(userDir, 'hooks.yaml'),
        'capture-session:\n  script: capture.sh\n  events: [SessionStart]\n  timeout: 5\n',
      );

      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'hooks.yaml'))).toBe(false);
      const meta = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
      expect(meta).toContain('hooks:');
      expect(meta).toContain('capture-session');
      expect(meta).toContain('script: capture.sh');
      expect(fs.readFileSync(devicePinsFile(), 'utf-8')).toMatch(/"agents":\s*\{[^}]*"claude"/);
    });

    it('creates agents.yaml when only hooks.yaml exists', () => {
      fs.writeFileSync(
        path.join(userDir, 'hooks.yaml'),
        'lonely:\n  script: a.sh\n  events: [Stop]\n',
      );

      runRealMigration();

      expect(fs.existsSync(path.join(userDir, 'hooks.yaml'))).toBe(false);
      const meta = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
      expect(meta).toContain('hooks:');
      expect(meta).toContain('lonely:');
    });

    it('preserves existing agents.yaml hooks: entries on collision (existing wins)', () => {
      fs.writeFileSync(
        path.join(userDir, 'agents.yaml'),
        'hooks:\n  shared:\n    script: existing.sh\n    events: [Stop]\n',
      );
      fs.writeFileSync(
        path.join(userDir, 'hooks.yaml'),
        'shared:\n  script: incoming.sh\n  events: [SessionStart]\n',
      );

      runRealMigration();

      const meta = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
      expect(meta).toContain('script: existing.sh');
      expect(meta).not.toContain('incoming.sh');
    });

    it('is idempotent (no hooks.yaml = no-op)', () => {
      fs.writeFileSync(
        path.join(userDir, 'agents.yaml'),
        'agents:\n  claude: 2.1.0\n',
      );

      runRealMigration();
      runRealMigration();

      expect(fs.readFileSync(devicePinsFile(), 'utf-8')).toContain('"claude": "2.1.0"');
    });
  });

  it('splits machine-local fields out of central and clears skip-worktree in a git repo', () => {
    fs.writeFileSync(
      path.join(userDir, 'agents.yaml'),
      'agents:\n  claude: "2.1.0"\nversions:\n  claude:\n    "2.1.0":\n      rulesPreset: default\nrun:\n  claude:\n    strategy: balanced\n',
    );
    const g = (...args: string[]): string =>
      execFileSync('git', args, { cwd: userDir, encoding: 'utf-8', stdio: 'pipe' });
    g('init', '-q');
    g('add', 'agents.yaml');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    g('update-index', '--skip-worktree', 'agents.yaml');

    runRealMigration();

    const central = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
    expect(central).not.toMatch(/^agents:/m);
    expect(central).not.toMatch(/^versions:/m);
    expect(central).toContain('run:');
    expect(fs.readFileSync(devicePinsFile(), 'utf-8')).toContain('2.1.0');
    const history = JSON.parse(
      fs.readFileSync(path.join(userDir, '.history', 'version-resources.json'), 'utf-8'),
    );
    expect(history.claude['2.1.0'].rulesPreset).toBe('default');

    expect(g('ls-files', '-v', 'agents.yaml').startsWith('S ')).toBe(false);
  });

  it('clears skip-worktree without rewriting a portable-only central agents.yaml', () => {
    const original = 'run:\n  claude:\n    strategy: balanced\n';
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), original);
    const g = (...args: string[]): string =>
      execFileSync('git', args, { cwd: userDir, encoding: 'utf-8', stdio: 'pipe' });
    g('init', '-q');
    g('add', 'agents.yaml');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    g('update-index', '--skip-worktree', 'agents.yaml');

    runRealMigration();

    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toContain('strategy: balanced');
    expect(fs.existsSync(devicePinsFile())).toBe(false);
    expect(g('ls-files', '-v', 'agents.yaml').startsWith('S ')).toBe(false);
  });

  describe('system-repo sweep', () => {
    it('moves system sessions/ filesystem entries into ~/.agents/.history/sessions/', () => {
      const sysSessions = path.join(systemDir, 'sessions');
      fs.mkdirSync(path.join(sysSessions, 'claude'), { recursive: true });
      fs.writeFileSync(path.join(sysSessions, 'claude', 's1.jsonl'), 'evt1\n');
      fs.writeFileSync(path.join(sysSessions, 'index.jsonl'), 'ix1\n');
      fs.writeFileSync(path.join(sysSessions, 'content_index.jsonl'), 'cix1\n');
      fs.writeFileSync(path.join(sysSessions, 'error-handling-anecdote.txt'), 'anecdote');

      runRealMigration();

      const dest = path.join(userDir, '.history', 'sessions');
      expect(fs.readFileSync(path.join(dest, 'claude', 's1.jsonl'), 'utf-8')).toBe('evt1\n');
      expect(fs.readFileSync(path.join(dest, 'index.jsonl'), 'utf-8')).toBe('ix1\n');
      expect(fs.readFileSync(path.join(dest, 'content_index.jsonl'), 'utf-8')).toBe('cix1\n');
      expect(fs.readFileSync(path.join(dest, 'error-handling-anecdote.txt'), 'utf-8')).toBe('anecdote');
      expect(fs.existsSync(sysSessions)).toBe(false);
    });

    it('moves system teams/ live state to ~/.agents/teams/ and per-run dirs to .history/teams/', () => {
      const sysTeams = path.join(systemDir, 'teams');
      fs.mkdirSync(sysTeams, { recursive: true });
      fs.writeFileSync(path.join(sysTeams, 'config.json'), '{"v":1}');
      fs.writeFileSync(path.join(sysTeams, 'registry.json'), '{"teams":[]}');
      fs.mkdirSync(path.join(sysTeams, 'agents', 'abc123'), { recursive: true });
      fs.writeFileSync(path.join(sysTeams, 'agents', 'abc123', 'meta.json'), '{"id":"abc123"}');
      fs.mkdirSync(path.join(sysTeams, 'ralph-smoke-1'), { recursive: true });
      fs.writeFileSync(path.join(sysTeams, 'ralph-smoke-1', 'log.txt'), 'ralph log');

      runRealMigration();

      expect(fs.readFileSync(path.join(userDir, 'teams', 'config.json'), 'utf-8')).toBe('{"v":1}');
      expect(fs.readFileSync(path.join(userDir, 'teams', 'registry.json'), 'utf-8')).toBe('{"teams":[]}');
      expect(fs.readFileSync(path.join(userDir, '.history', 'teams', 'agents', 'abc123', 'meta.json'), 'utf-8'))
        .toBe('{"id":"abc123"}');
      expect(fs.readFileSync(path.join(userDir, '.history', 'teams', 'ralph-smoke-1', 'log.txt'), 'utf-8'))
        .toBe('ralph log');
      expect(fs.existsSync(sysTeams)).toBe(false);
    });

    it('moves system trash/ into ~/.agents/.history/trash/', () => {
      const sysTrash = path.join(systemDir, 'trash', 'versions', 'claude', '1.0');
      fs.mkdirSync(sysTrash, { recursive: true });
      fs.writeFileSync(path.join(sysTrash, 'note.txt'), 'discarded');

      runRealMigration();

      expect(fs.readFileSync(path.join(userDir, '.history', 'trash', 'versions', 'claude', '1.0', 'note.txt'), 'utf-8'))
        .toBe('discarded');
      expect(fs.existsSync(path.join(systemDir, 'trash'))).toBe(false);
    });

    it('moves system repos/<alias>/ to ~/.agents-<alias>/ peer dirs', () => {
      const sysRepo = path.join(systemDir, 'repos', 'default');
      fs.mkdirSync(sysRepo, { recursive: true });
      fs.writeFileSync(path.join(sysRepo, 'AGENTS.md'), '# default repo');

      runRealMigration();

      expect(fs.readFileSync(path.join(testHome, '.agents-default', 'AGENTS.md'), 'utf-8')).toBe('# default repo');
      expect(fs.existsSync(path.join(systemDir, 'repos'))).toBe(false);
    });

    it('drops legacy swarm/ bookkeeping JSONs and folds swarm/agents/ into .history/teams/agents/', () => {
      const sysSwarm = path.join(systemDir, 'swarm');
      fs.mkdirSync(path.join(sysSwarm, 'agents', 'sw1'), { recursive: true });
      fs.writeFileSync(path.join(sysSwarm, 'agents', 'sw1', 'state.json'), '{"id":"sw1"}');
      fs.writeFileSync(path.join(sysSwarm, 'cache.json'), '{}');
      fs.writeFileSync(path.join(sysSwarm, 'config.json'), '{}');
      fs.writeFileSync(path.join(sysSwarm, 'teams.json'), '{}');

      runRealMigration();

      expect(fs.readFileSync(path.join(userDir, '.history', 'teams', 'agents', 'sw1', 'state.json'), 'utf-8'))
        .toBe('{"id":"sw1"}');
      expect(fs.existsSync(sysSwarm)).toBe(false);
    });

    it('drops dead bin/agents-keychain-* and empty shims/', () => {
      const binDir = path.join(systemDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'agents-keychain-abc123'), '#!/bin/sh\n');
      fs.mkdirSync(path.join(systemDir, 'shims'), { recursive: true });

      runRealMigration();

      expect(fs.existsSync(binDir)).toBe(false);
      expect(fs.existsSync(path.join(systemDir, 'shims'))).toBe(false);
    });

    it('moves system cache/ contents into ~/.agents/.cache/ and drops claude-usage.json', () => {
      const sysCache = path.join(systemDir, 'cache');
      fs.mkdirSync(sysCache, { recursive: true });
      fs.writeFileSync(path.join(sysCache, 'claude-usage.json'), '{"usage":1}');
      fs.mkdirSync(path.join(sysCache, 'cloud-runs', 'r1'), { recursive: true });
      fs.writeFileSync(path.join(sysCache, 'cloud-runs', 'r1', 'out.txt'), 'run-1');

      runRealMigration();

      expect(fs.existsSync(path.join(sysCache))).toBe(false);
      expect(fs.readFileSync(path.join(userDir, '.cache', 'cloud-runs', 'r1', 'out.txt'), 'utf-8')).toBe('run-1');
    });

    it('moves system cloud/tasks.db wholesale when user-side dest is missing', () => {
      const sysCloud = path.join(systemDir, 'cloud');
      fs.mkdirSync(sysCloud, { recursive: true });
      fs.writeFileSync(path.join(sysCloud, 'tasks.db'), 'fake-sqlite-bytes');

      runRealMigration();

      expect(fs.existsSync(path.join(sysCloud, 'tasks.db'))).toBe(false);
      expect(fs.readFileSync(path.join(userDir, '.cache', 'cloud', 'tasks.db'), 'utf-8')).toBe('fake-sqlite-bytes');
    });

    it('warns about unexpected leftover dirs in system repo', () => {
      fs.mkdirSync(path.join(systemDir, 'mystery-leftover'), { recursive: true });
      fs.writeFileSync(path.join(systemDir, 'mystery-leftover', 'data.txt'), 'unknown');

      const modulePath = path.resolve(process.cwd(), 'src/lib/installations/migrate.ts');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawnSync } = require('child_process') as typeof import('child_process');
      const proc = spawnSync(
        'bun',
        ['-e', `import { runMigration } from ${JSON.stringify(modulePath)}; await runMigration();`],
        { cwd: process.cwd(), env: { ...process.env, HOME: testHome } },
      );
      expect(proc.stderr.toString('utf-8')).toContain('mystery-leftover');
    });
  });

  describe('plugins/ — user-authored resource at user-root (issue #20)', () => {
    it('does NOT move ~/.agents/plugins/ into ~/.agents/.cache/plugins/', () => {
      const pluginDir = path.join(userDir, 'plugins', 'rush', '.claude-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), '{"name":"rush","version":"1.0.0"}');
      fs.writeFileSync(path.join(userDir, 'plugins', 'rush', 'SKILL.md'), 'user-authored');

      runRealMigration();

      expect(fs.readFileSync(path.join(userDir, 'plugins', 'rush', 'SKILL.md'), 'utf-8')).toBe('user-authored');
      expect(fs.readFileSync(path.join(userDir, 'plugins', 'rush', '.claude-plugin', 'plugin.json'), 'utf-8'))
        .toBe('{"name":"rush","version":"1.0.0"}');
      expect(fs.existsSync(path.join(userDir, '.cache', 'plugins', 'rush'))).toBe(false);
    });

    it('moves cached plugins back to user-root for users upgrading from the broken layout', () => {
      const cachedPlugin = path.join(userDir, '.cache', 'plugins', 'duck');
      fs.mkdirSync(cachedPlugin, { recursive: true });
      fs.writeFileSync(path.join(cachedPlugin, 'SKILL.md'), 'cached-content');

      runRealMigration();

      expect(fs.readFileSync(path.join(userDir, 'plugins', 'duck', 'SKILL.md'), 'utf-8')).toBe('cached-content');
      expect(fs.existsSync(path.join(userDir, '.cache', 'plugins', 'duck'))).toBe(false);
    });

    it('preserves the user-root copy when both locations exist (user wins)', () => {
      const userPlugin = path.join(userDir, 'plugins', 'rush');
      const cachedPlugin = path.join(userDir, '.cache', 'plugins', 'rush');
      fs.mkdirSync(userPlugin, { recursive: true });
      fs.mkdirSync(cachedPlugin, { recursive: true });
      fs.writeFileSync(path.join(userPlugin, 'SKILL.md'), 'user-version');
      fs.writeFileSync(path.join(cachedPlugin, 'SKILL.md'), 'cached-version');
      fs.writeFileSync(path.join(cachedPlugin, 'OLD.md'), 'cached-only');

      runRealMigration();

      expect(fs.readFileSync(path.join(userPlugin, 'SKILL.md'), 'utf-8')).toBe('user-version');
      expect(fs.existsSync(path.join(userPlugin, 'OLD.md'))).toBe(false);
      expect(fs.readFileSync(path.join(cachedPlugin, 'SKILL.md'), 'utf-8')).toBe('cached-version');
      expect(fs.readFileSync(path.join(cachedPlugin, 'OLD.md'), 'utf-8')).toBe('cached-only');
    });
  });
});
