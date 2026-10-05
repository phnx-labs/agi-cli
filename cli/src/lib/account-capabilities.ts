import type { AgentId } from './types.js';

// Inspection is identity strength; scope is login isolation; status is selector support.
// Device-scoped opaque logins stay unsupported until NativeAccount carries a device key.
interface NativeAccountCapability {
  inspection: 'strong' | 'email' | 'opaque' | 'none';
  scope: 'version' | 'device' | 'unsupported';
  status: 'supported' | 'conditional' | 'discovery-only' | 'unsupported';
}

export const NATIVE_ACCOUNT_SELECTOR_AGENTS = ['claude', 'codex', 'cursor', 'grok', 'kimi'] as const satisfies readonly AgentId[];

export const NATIVE_ACCOUNT_SELECTOR_EXCLUSIONS: Partial<Record<AgentId, string>> = {
  copilot: 'no inspectable native identity',
  opencode: 'provider-set identity is not safely attributable to one native login',
  muse: 'email-only conditional identity is outside the RUSH-3053 harness contract',
};

export const NATIVE_ACCOUNT_CAPABILITIES: Record<AgentId, NativeAccountCapability> = {
  claude: { inspection: 'strong', scope: 'version', status: 'supported' },
  codex: { inspection: 'strong', scope: 'version', status: 'supported' },
  grok: { inspection: 'strong', scope: 'version', status: 'supported' },
  cursor: { inspection: 'strong', scope: 'version', status: 'supported' },
  kimi: { inspection: 'opaque', scope: 'version', status: 'supported' },
  muse: { inspection: 'email', scope: 'version', status: 'conditional' },
  antigravity: { inspection: 'opaque', scope: 'device', status: 'unsupported' },
  droid: { inspection: 'opaque', scope: 'device', status: 'unsupported' },
  opencode: { inspection: 'opaque', scope: 'device', status: 'unsupported' },
  copilot: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  openclaw: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  amp: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  goose: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  hermes: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  warp: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
};

export function nativeAccountCapability(agent: AgentId): NativeAccountCapability {
  return NATIVE_ACCOUNT_CAPABILITIES[agent];
}

export function nativeAccountNameable(agent: AgentId): boolean {
  const cap = NATIVE_ACCOUNT_CAPABILITIES[agent];
  return (cap.status === 'supported' || cap.status === 'conditional') && cap.scope !== 'unsupported';
}

export function supportedNativeHarnesses(): AgentId[] {
  return (Object.entries(NATIVE_ACCOUNT_CAPABILITIES) as [AgentId, NativeAccountCapability][])
    .filter(([, cap]) => cap.status === 'supported')
    .map(([id]) => id)
    .sort();
}

export function nativeAccountNamingRefusal(agent: AgentId): string | null {
  if (nativeAccountNameable(agent)) return null;
  const cap = NATIVE_ACCOUNT_CAPABILITIES[agent];
  const suffix = `Supported today: ${supportedNativeHarnesses().join(', ')}.`;
  if (cap.scope === 'device') {
    return `${agent} accounts can't be isolated by agents-cli yet (device-scoped login). ${suffix}`;
  }
  if (cap.status === 'discovery-only') {
    return `${agent} native accounts are discovery-only; agents-cli cannot name or attach this login. ${suffix}`;
  }
  return `${agent} accounts can't be named by agents-cli yet. ${suffix}`;
}

export function assertNativeAccountNameable(agent: AgentId): void {
  const reason = nativeAccountNamingRefusal(agent);
  if (reason) throw new Error(reason);
}

export function nativeIdentityKey(
  info: { signedIn?: boolean; email?: string | null; accountKey?: string | null },
  capability: NativeAccountCapability,
): string | null {
  // Every path prefers stable accountKey; normalized email is the legacy fallback.
  // Muse still requires email presence, and a supplied key remains muse:email=....
  if (!info.signedIn) return null;
  if (capability.inspection === 'email' && !info.email) return null;
  return info.accountKey ?? info.email?.toLowerCase() ?? null;
}
