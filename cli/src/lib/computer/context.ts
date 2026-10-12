/**
 * context.ts — everything agents-cli knows that the standalone `computer`
 * engine cannot work out for itself, serialized as one JSON object onto fd 3.
 *
 * This is the whole contract of the consumer half, and it is deliberately
 * small. The engine accepts exactly this shape:
 *
 *   version      `1`. The engine matches on it; a field added later must be
 *                optional so an older engine keeps working.
 *   permissions  which apps are allowed, derived from `Computer(<bundle-id>)`
 *                rules in the agents permissions resource layer. The engine
 *                would have to re-learn resource layering to compute this.
 *   peers        which executables the daemon accepts a connection from.
 *   session      who is acting — actor id and agent session — so an action
 *                lands in the right session history.
 *
 * WHAT IS DELIBERATELY NOT HERE. The transport (`COMPUTER_HELPER_TCP`,
 * `COMPUTER_HELPER_VNC`, `COMPUTER_HELPER_SOCKET`), the remote helper's auth
 * token, and the policy-file paths are the ENGINE's: it provisions the Windows
 * helper, mints and stores the token, opens the `ssh -L` tunnel and hydrates its
 * own transport from the state it wrote. agents-cli publishing a loopback
 * endpoint here (or on `COMPUTER_HELPER_TCP`) would be a second, drifting copy
 * of that answer — and a copy without the token, which the daemon rejects with
 * `auth_failed`. Service-manager safety (launchd/systemd registration under a
 * redirected HOME) is likewise the standalone's own: it inherits `HOME` and
 * `AGENTS_REAL_HOME` and renders its own manifest, so agents-cli neither
 * computes a label nor issues a verdict for it.
 *
 * The context is PUSHED (written and closed) rather than exposed as a callback,
 * so the engine never re-enters agents-cli and there is exactly one direction of
 * dependency.
 */

import { resolveActor } from '../actor.js';
import { loadComputerAllowList, loadDefaultPeers } from './policy.js';

interface ComputerSessionContext {
  sessionId?: string;
  launchId?: string;
  actor: string;
}

interface ComputerContext {
  version: 1;
  permissions?: { allow: string[] };
  peers: { allow: string[] };
  session: ComputerSessionContext;
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

export async function buildComputerContext(opts: { computerBin?: string } = {}): Promise<ComputerContext> {
  return {
    version: 1,
    ...(!process.env.COMPUTER_HELPER_TCP && !process.env.COMPUTER_HELPER_VNC
      ? { permissions: { allow: loadComputerAllowList() } } : {}),
    peers: { allow: loadDefaultPeers({ computerBin: opts.computerBin }) },
    session: {
      sessionId: agentSessionId(),
      launchId: process.env.AGENT_LAUNCH_ID,
      actor: resolveActor().id,
    },
  };
}
