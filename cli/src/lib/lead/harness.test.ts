import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEAD_ALLOWED_TOOLS, cliVersion, curatedClientEnv, workerEnv, leadChildEnv, leadRunArgs, leadSettings, writeAgentsShim, writeLeadSettings } from './harness.js';
import { ensureLeadDir, leadRoot } from './paths.js';

describe('Lead harness launch', () => {
  const paths = ensureLeadDir('harness-demo');

  it('launches isolated in the Lead dir with only the Lead tools allowed', () => {
    const args = leadRunArgs('harness-demo', 'sonnet', { mode: 'fresh', sessionId: 'u-1' }, paths);
    const pass = args.slice(args.indexOf('--') + 1);
    expect(args.slice(0, args.indexOf('--'))).toEqual([
      'run', 'claude', '--headless', '--quiet', '--cwd', paths.dir, '--model', 'sonnet', '--effort', 'low',
      '--session-id', 'u-1', '--name', 'lead-harness-demo',
    ]);
    expect(pass).toEqual(expect.arrayContaining(['--setting-sources', 'local', '--settings', paths.settings, '--strict-mcp-config', '--tools', 'Bash', '--permission-mode', 'dontAsk']));
    const allowed = pass.slice(pass.indexOf('--allowedTools') + 1, pass.indexOf('--disallowedTools'));
    expect(allowed).toEqual([...LEAD_ALLOWED_TOOLS]);
    expect(allowed.every((a) => a.startsWith('Bash(agents lead tool '))).toBe(true);
    expect(leadRunArgs('harness-demo', 'sonnet', { mode: 'resume', sessionId: 'u-1' }, paths)).toEqual(expect.arrayContaining(['--resume', 'u-1']));
  });

  it('writes a settings file with no hooks and only the tool permissions', () => {
    writeLeadSettings(paths);
    expect(JSON.parse(fs.readFileSync(paths.settings, 'utf-8'))).toEqual(leadSettings());
    expect(leadSettings()).toMatchObject({ disableAllHooks: true, permissions: { defaultMode: 'dontAsk', allow: [...LEAD_ALLOWED_TOOLS] } });
  });

  it('passes a minimal env: no unrelated secrets, the shim dir first on PATH, the project set', () => {
    const env = leadChildEnv('harness-demo', paths, {
      PATH: '/usr/bin', HOME: '/home/u', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't',
    });
    expect(env).toEqual({
      PATH: `${paths.bin}:/usr/bin`, HOME: '/home/u', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't',
      AGENTS_LEAD_PROJECT: 'harness-demo', AGENTS_NO_AUTOPULL: '1', LINEAR_PROFILE: 'default',
    });
  });

  it('points the Lead at its project\'s Linear workspace, and nothing from the host env decides it', () => {
    expect(leadChildEnv('harness-demo', paths, { PATH: '/usr/bin', LINEAR_PROFILE: 'turing' }, 'personal').LINEAR_PROFILE).toBe('personal');
    expect(leadChildEnv('harness-demo', paths, { PATH: '/usr/bin', LINEAR_PROFILE: 'turing' }).LINEAR_PROFILE).toBe('default');
    expect(curatedClientEnv({ LINEAR_PROFILE: 'personal' })).toEqual({});
    const shell = { PATH: '/usr/bin', LINEAR_PROFILE: 'turing' };
    expect(workerEnv(shell, { LINEAR_PROFILE: 'turing' }, leadRoot(), 'personal').LINEAR_PROFILE).toBe('personal');
    expect(workerEnv(shell, { LINEAR_PROFILE: 'turing' }, leadRoot()).LINEAR_PROFILE).toBe('default');
  });

  it('writes an executable agents shim pinned to the host CLI', () => {
    const file = writeAgentsShim(paths, { command: '/usr/bin/node', args: ["/opt/it's/index.js"] });
    expect(fs.readFileSync(file, 'utf-8')).toBe(`#!/bin/sh\nexec '/usr/bin/node' '/opt/it'\\''s/index.js' "$@"\n`);
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
  });

  it('gives dispatched workers the caller env minus every Lead marker and the Lead shim', () => {
    const lead = leadChildEnv('harness-demo', paths, { PATH: '/usr/bin', HOME: '/home/u' });
    const env = workerEnv(lead, curatedClientEnv({
      PATH: '/home/u/.local/bin:/usr/bin', SSH_AUTH_SOCK: '/run/ssh', GH_TOKEN: 'g', LINEAR_API_KEY: 'l', DISPLAY: ':0',
      AGENTS_LEAD_PROJECT: 'evil', RANDOM_SECRET: 'nope',
    }), leadRoot());
    expect(env).toMatchObject({ PATH: '/home/u/.local/bin:/usr/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/run/ssh', GH_TOKEN: 'g', LINEAR_API_KEY: 'l', DISPLAY: ':0' });
    expect(env.AGENTS_LEAD_PROJECT).toBeUndefined();
    expect(env.AGENTS_NO_AUTOPULL).toBeUndefined();
    expect(env.RANDOM_SECRET).toBeUndefined();
    const hostOnly = workerEnv(lead, {}, leadRoot());
    expect(hostOnly.PATH).toBe('/usr/bin');
    expect(hostOnly.AGENTS_LEAD_PROJECT).toBeUndefined();
  });

  it('reads the CLI version from package.json', () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
