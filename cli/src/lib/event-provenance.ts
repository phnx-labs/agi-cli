import * as os from 'os';
import { resolveActor, type ActorKind } from './actor.js';
import { machineId } from './machine-id.js';
import { parseSshConnection } from './session/provenance.js';

interface EventProvenance {
  osUser: string;
  transport: 'local' | 'ssh';
  sshClientIp?: string;
  actor: string;
  kind: ActorKind;
  machineId: string;
  sessionId?: string;
  agent?: string;
  launchId?: string;
  parentSessionId?: string;
  parentLaunchId?: string;
  originTerminalId?: string;
  originDevice?: string;
}

interface AuditOrigin {
  osUser: string;
  transport: 'local' | 'ssh';
  sshClientIp?: string;
  actor: string;
  kind: ActorKind;
}

let cachedOrigin: AuditOrigin | undefined;
let cachedDeviceId: string | undefined;

export function stampProvenance(env: NodeJS.ProcessEnv = process.env): EventProvenance {
  if (!cachedOrigin) {
    let osUser = 'unknown';
    try {
      osUser = os.userInfo().username;
    } catch {
    }
    const ssh = env.SSH_CONNECTION ? parseSshConnection(env.SSH_CONNECTION) : undefined;
    const actor = resolveActor();
    cachedOrigin = {
      osUser,
      transport: ssh ? 'ssh' : 'local',
      ...(ssh ? { sshClientIp: ssh.clientIp } : {}),
      actor: actor.id,
      kind: actor.kind,
    };
  }

  const provenance: EventProvenance = {
    ...cachedOrigin,
    machineId: (cachedDeviceId ??= machineId()),
  };
  const sessionId = env.AGENT_SESSION_ID || env.AGENTS_SESSION_ID;
  if (sessionId) provenance.sessionId = sessionId;
  if (env.AGENTS_AGENT_NAME) provenance.agent = env.AGENTS_AGENT_NAME;
  if (env.AGENT_LAUNCH_ID) provenance.launchId = env.AGENT_LAUNCH_ID;
  if (env.AGENTS_PARENT_SESSION_ID) provenance.parentSessionId = env.AGENTS_PARENT_SESSION_ID;
  if (env.AGENTS_PARENT_LAUNCH_ID) provenance.parentLaunchId = env.AGENTS_PARENT_LAUNCH_ID;
  if (env.AGENTS_ORIGIN_TERMINAL_ID) provenance.originTerminalId = env.AGENTS_ORIGIN_TERMINAL_ID;
  if (env.AGENTS_ORIGIN_DEVICE) provenance.originDevice = env.AGENTS_ORIGIN_DEVICE;
  return provenance;
}

export function resetEventProvenanceForTest(): void {
  cachedOrigin = undefined;
  cachedDeviceId = undefined;
}
