
import { resolveActor } from '../actor.js';
import { resolveRemoteDevice } from '../ssh-tunnel.js';
import { getConfigValue } from '../device-config.js';

export interface BrowserTargetContext {
  alias: string;
  host: string;
  user: string;
  hostname: string;
  platform: string;
  sshArgs: string[];
}

interface BrowserSessionContext {
  sessionId?: string;
  launchId?: string;
  actor: string;
}

interface BrowserContext {
  version: 1;
  target?: BrowserTargetContext;
  session: BrowserSessionContext;
  remoteControl: { allowed: boolean };
}

function agentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CODEX_THREAD_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CLAUDE_SESSION_ID
    || env.AGENTS_SESSION_ID
    || env.AGENT_SESSION_ID
    || env.AGENTS_RUN_ID
    || undefined;
}

export function remoteControlEnabled(): boolean {
  return getConfigValue('browser.remote-control').value === true;
}

interface BuildContextOptions {
  device?: string;
  target?: BrowserTargetContext;
}

export async function buildBrowserContext(opts: BuildContextOptions = {}): Promise<BrowserContext> {
  let target: BrowserTargetContext | undefined = opts.target;
  if (!target && opts.device && opts.device !== 'local') {
    const resolved = await resolveRemoteDevice(opts.device);
    target = {
      alias: opts.device,
      host: resolved.target,
      user: resolved.user,
      hostname: resolved.host,
      platform: resolved.device.platform,
      sshArgs: resolved.identityArgs,
    };
  }

  return {
    version: 1,
    ...(target ? { target } : {}),
    session: {
      sessionId: agentSessionId(),
      launchId: process.env.AGENT_LAUNCH_ID,
      actor: resolveActor().id,
    },
    remoteControl: { allowed: remoteControlEnabled() },
  };
}
