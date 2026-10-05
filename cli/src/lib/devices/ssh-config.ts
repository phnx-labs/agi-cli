import { type DeviceProfile, type DeviceRegistry } from './registry.js';
import { resolveDeviceProfile } from './resolve-profile.js';

const HEADER = [
  '# Managed by `agents devices` — do not edit by hand.',
  '# Regenerate with: agents devices render',
  '# Include from ~/.ssh/config with:  Include config.d/agents',
].join('\n');

export function hostNameFor(device: DeviceProfile): string | undefined {
  return device.address.dnsName ?? device.address.ip;
}

function renderHost(device: DeviceProfile): string | null {
  const resolved = resolveDeviceProfile(device);
  const hostName = hostNameFor(resolved);
  if (!hostName) return null;
  const lines = [`Host ${resolved.name}`, `    HostName ${hostName}`];
  if (resolved.user) lines.push(`    User ${resolved.user}`);
  if (resolved.auth.method === 'key' && resolved.auth.identityFile) {
    lines.push(`    IdentityFile ${resolved.auth.identityFile}`, '    IdentitiesOnly yes');
  }
  return lines.join('\n');
}

export function renderSshConfig(reg: DeviceRegistry): string {
  const stanzas: string[] = [];
  for (const name of Object.keys(reg).sort()) {
    const stanza = renderHost(reg[name]);
    if (stanza) stanzas.push(stanza);
  }
  return [HEADER, '', ...stanzas, ''].join('\n');
}
