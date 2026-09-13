import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as TOML from 'smol-toml';
import * as YAML from 'yaml';
import { installHookFor, HOOK_AGENTS } from '../src/install-hook.js';

const roots: string[] = [];

function tmpHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-install-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('session tracker hook installation', () => {
  it.each(['claude', 'codex', 'droid'] as const)('replaces only managed legacy %s trackers', async (agent) => {
    const root = tmpHome();
    const dir = agent === 'droid' ? '.factory' : `.${agent}`;
    const file = path.join(root, dir, agent === 'codex' ? 'hooks.json' : 'settings.json');
    const current = '/installed/session-tracker/dist/hook.sh';
    const legacy = `${root}/.agents/.cache/shims/builtin-hooks/session-tracker.sh`;
    const unrelated = `${root}/user-hooks/session-tracker.sh`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ matcher: '', hooks: [
      { type: 'command', command: legacy },
      { type: 'command', command: '/obsolete/session-tracker/src/hook.sh ' + agent },
      { type: 'command', command: unrelated },
    ] }] } }));
    for (let pass = 0; pass < 2; pass++) {
      const result = await installHookFor(agent, { home: root, hookPathOverride: current });
      expect(result.installed, result.error).toBe(true);
      const commands = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart
        .flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command));
      expect(commands).toEqual([unrelated, `${current} ${agent}`]);
    }
  });

  it('registers Droid and Kimi SessionStart hooks in their native config formats', () => {
    const root = tmpHome();
    const result = spawnSync(process.execPath, [
      path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/install-hook.ts', 'droid', 'kimi',
    ], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);

    const droid = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'settings.json'), 'utf8'));
    expect(droid.hooks.SessionStart[0].hooks[0].command).toContain('hook.sh droid');

    const kimi = TOML.parse(fs.readFileSync(path.join(root, '.kimi-code', 'config.toml'), 'utf8')) as any;
    expect(kimi.hooks).toContainEqual(expect.objectContaining({ event: 'SessionStart' }));
    expect(kimi.hooks[0].command).toContain('hook.sh kimi');
  });

  // RUSH-2205: hermes is newly covered by the writer. Its native config is
  // ~/.hermes/config.yaml, SessionStart -> `on_session_start`, read-modify-write
  // so sibling keys (mcp_servers) survive. os.homedir() honours $HOME on POSIX.
  it('registers the Hermes SessionStart hook in config.yaml, preserving siblings', async () => {
    const root = tmpHome();
    const configPath = path.join(root, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, YAML.stringify({ mcp_servers: { demo: { command: 'x' } } }), 'utf8');

    const prevHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const r = await installHookFor('hermes', { home: root });
      expect(r.installed, r.error).toBe(true);
      expect(r.configPath).toBe(configPath);

      const cfg = YAML.parse(fs.readFileSync(configPath, 'utf8')) as any;
      // The managed hook landed under on_session_start...
      expect(cfg.hooks.on_session_start[0].command).toContain('hook.sh hermes');
      // ...and the pre-existing sibling key was preserved, not clobbered.
      expect(cfg.mcp_servers.demo.command).toBe('x');

      // Idempotent: a second install does not duplicate the managed entry.
      await installHookFor('hermes', { home: root });
      const cfg2 = YAML.parse(fs.readFileSync(configPath, 'utf8')) as any;
      const managed = cfg2.hooks.on_session_start.filter((h: any) =>
        String(h.command).includes('hook.sh'),
      );
      expect(managed.length).toBe(1);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  // Truthfulness guard (RUSH-2205): no AgentId falls through to a generic
  // "not yet implemented". Every agent either installs successfully or returns a
  // SPECIFIC reason it genuinely cannot host the writer hook.
  it('every AgentId is either installable or carries a specific unsupported reason', async () => {
    const root = tmpHome();
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(HOOK_AGENTS.length).toBeGreaterThanOrEqual(10);
      for (const agent of HOOK_AGENTS) {
        const r = await installHookFor(agent, { dryRun: true });
        if (r.configPath) {
          // Installable agents resolve a real native config path (even on dry-run).
          expect(r.configPath, `${agent} should resolve a config path`).toBeTruthy();
        } else {
          expect(r.error, `${agent} must state a reason`).toBeTruthy();
          expect(r.error, `${agent} must not use the generic fallback`).not.toContain('not yet implemented');
        }
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});


  it('is idempotent when the hook command uses the built dist path', () => {
    const root = tmpHome();
    const result = spawnSync(process.execPath, [
      path.join(import.meta.dirname, '..', 'dist', 'install-hook.js'),
      'claude',
    ], {
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);

    // Run again; the second install should strip the first entry before adding.
    const result2 = spawnSync(process.execPath, [
      path.join(import.meta.dirname, '..', 'dist', 'install-hook.js'),
      'claude',
    ], {
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
    });
    expect(result2.status, result2.stderr).toBe(0);

    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const managed = cfg.hooks.SessionStart[0].hooks.filter((h: any) =>
      String(h.command).includes('hook.sh'),
    );
    expect(managed.length).toBe(1);
  });
