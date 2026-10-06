import { machineId } from './machine-id.js';

export function launchIdentityEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  const terminal = env.AGENT_TERMINAL_ID?.trim();
  const nested = env.AGENTS_RUNTIME === 'terminal' || env.AGENTS_RUNTIME === 'headless' || env.AGENTS_RUNTIME === 'teams';
  if (terminal && !nested) result.AGENT_TERMINAL_ID = terminal;
  const inheritedTerminal = env.AGENTS_ORIGIN_TERMINAL_ID?.trim();
  const originTerminal = inheritedTerminal || terminal;
  if (originTerminal) {
    result.AGENTS_ORIGIN_TERMINAL_ID = originTerminal;
    result.AGENTS_ORIGIN_DEVICE = (inheritedTerminal && env.AGENTS_ORIGIN_DEVICE?.trim()) || machineId();
  }
  const parentLaunch = nested ? env.AGENT_LAUNCH_ID : env.AGENTS_PARENT_LAUNCH_ID;
  const parentSession = nested
    ? env.AGENTS_SESSION_ID || env.AGENT_SESSION_ID
    : env.AGENTS_PARENT_SESSION_ID;
  if (parentLaunch) result.AGENTS_PARENT_LAUNCH_ID = parentLaunch;
  if (parentSession) result.AGENTS_PARENT_SESSION_ID = parentSession;
  return result;
}

export interface LaunchOrigin {
  device: string;
  terminalId: string;
}

export function launchOrigin(identity: Record<string, string> = launchIdentityEnv()): LaunchOrigin | undefined {
  const device = identity.AGENTS_ORIGIN_DEVICE;
  const terminalId = identity.AGENTS_ORIGIN_TERMINAL_ID;
  return device && terminalId && identity.AGENT_TERMINAL_ID ? { device, terminalId } : undefined;
}

export const LAUNCH_IDENTITY_KEYS = [
  'AGENT_TERMINAL_ID', 'AGENT_SESSION_ID', 'AGENTS_SESSION_ID', 'AGENTS_MAILBOX_DIR',
  'AGENT_LAUNCH_ID', 'AGENTS_PARENT_SESSION_ID', 'AGENTS_PARENT_LAUNCH_ID', 'AGENTS_ORIGIN_TERMINAL_ID',
  'AGENTS_ORIGIN_DEVICE',
] as const;
