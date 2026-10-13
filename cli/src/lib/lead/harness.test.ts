import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEAD_ALLOWED_TOOLS, cliVersion, leadChildEnv, leadRunArgs, leadSettings, writeAgentsShim, writeLeadSettings } from './harness.js';
import { ensureLeadDir } from './paths.js';

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
      AGENTS_LEAD_PROJECT: 'harness-demo', AGENTS_NO_AUTOPULL: '1',
    });
  });

  it('writes an executable agents shim pinned to the host CLI', () => {
    const file = writeAgentsShim(paths, { command: '/usr/bin/node', args: ["/opt/it's/index.js"] });
    expect(fs.readFileSync(file, 'utf-8')).toBe(`#!/bin/sh\nexec '/usr/bin/node' '/opt/it'\\''s/index.js' "$@"\n`);
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
  });

  it('reads the CLI version from package.json', () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
