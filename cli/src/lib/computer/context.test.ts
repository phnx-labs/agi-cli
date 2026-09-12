/**
 * The fd-3 context is the engine's input contract, so its SHAPE is the thing
 * under test: the engine accepts `version`/`permissions`/`peers`/`target`/
 * `session` and nothing else. A field the engine does not read is not a
 * harmless extra — it is a second, drifting copy of an answer the engine
 * already resolves for itself (the transport it hydrates from its own tunnel
 * state, for one).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { buildComputerContext } from './context.js';

const ENV_KEYS = [
  'CODEX_THREAD_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'AGENTS_SESSION_ID',
  'AGENT_SESSION_ID',
  'AGENTS_RUN_ID',
  'AGENT_LAUNCH_ID',
] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('buildComputerContext', () => {
  it('carries exactly the keys the engine accepts', async () => {
    const context = await buildComputerContext();
    expect(Object.keys(context).sort()).toEqual(['peers', 'permissions', 'session', 'version']);
    expect(context.version).toBe(1);
  });

  it('renders the permission and peer allow lists as string arrays', async () => {
    const context = await buildComputerContext({ computerBin: '/usr/local/bin/computer' });
    expect(Array.isArray(context.permissions!.allow)).toBe(true);
    expect(context.permissions!.allow.every((id) => typeof id === 'string')).toBe(true);
    // The standalone's own path is always a peer — it is the process that opens
    // the daemon socket now.
    expect(context.peers.allow).toContain('/usr/local/bin/computer');
  });

  it('keeps Mac bundle permissions out of remote and VNC contexts', async () => {
    expect((await buildComputerContext({ host: 'windows-host' })).permissions).toBeUndefined();
    setEnv('COMPUTER_HELPER_VNC', 'localhost:5901');
    expect((await buildComputerContext()).permissions).toBeUndefined();
    setEnv('COMPUTER_HELPER_VNC', undefined);
    setEnv('COMPUTER_HELPER_TCP', 'localhost:8765');
    expect((await buildComputerContext()).permissions).toBeUndefined();
  });

  it('names the acting session, preferring the harness-native id', async () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv('AGENTS_SESSION_ID', 'agents-own');
    setEnv('CLAUDE_CODE_SESSION_ID', 'claude-native');
    setEnv('AGENT_LAUNCH_ID', 'launch-7');
    const context = await buildComputerContext();
    expect(context.session.sessionId).toBe('claude-native');
    expect(context.session.launchId).toBe('launch-7');
    expect(typeof context.session.actor).toBe('string');
  });

  it('omits the target for a local invocation', async () => {
    expect((await buildComputerContext()).target).toBeUndefined();
  });
});
