/**
 * The generic `ssh -L` tunnel is shared fleet plumbing: `agents browser` drives
 * a remote CDP endpoint through it, and `agents computer --device` resolves a
 * device name through `resolveRemoteDevice` here before handing the answer to
 * the standalone engine. Both the option-injection sink and the hardened
 * baseline composition are pinned, since a regression in either is silent —
 * the tunnel still opens, it is just unhardened or attacker-influenced.
 */
import { describe, expect, it } from 'vitest';
import { buildTunnelArgs, startSSHTunnel } from './ssh-tunnel.js';
import { SSH_OPTS } from './ssh-exec.js';

describe('startSSHTunnel — target validation', () => {
  // buildTunnelArgs places `${user}@${host}` before `-N`/SSH_OPTS, so a
  // `-`-leading user (from a crafted ssh:// profile or device record) would be
  // parsed by ssh as an option flag. startSSHTunnel must reject before spawning.
  it('rejects an option-injecting user before spawning ssh', async () => {
    await expect(startSSHTunnel('-Fattacker', 'victim', 55000, 8765)).rejects.toThrow(/Invalid SSH target/);
  });

  it('rejects a host containing shell/option metacharacters', async () => {
    await expect(startSSHTunnel('me', 'a b;rm', 55000, 8765)).rejects.toThrow(/Invalid SSH target/);
  });
});

describe('buildTunnelArgs', () => {
  it('forwards localPort to the remote loopback port and stays hardened', () => {
    const args = buildTunnelArgs('muqsit', 'win-mini', 55000, 8765);
    // The -L mapping is the whole point: local -> 127.0.0.1:remote on the box.
    expect(args).toContain('-L');
    expect(args).toContain('55000:127.0.0.1:8765');
    expect(args).toContain('muqsit@win-mini');
    expect(args).toContain('-N'); // no remote command, just forwarding
    expect(args.join(' ')).toContain('StrictHostKeyChecking=accept-new');
    expect(args.join(' ')).toContain('BatchMode=yes');
    expect(args.join(' ')).toContain('ConnectTimeout=10');
  });

  it('is the -L mapping + target + -N followed by the shared hardened baseline', () => {
    // The tunnel composes the canonical SSH_OPTS instead of re-listing the
    // options, so it automatically inherits the keepalive (which lets a dropped
    // -N tunnel exit instead of zombying) and any future baseline hardening.
    expect(buildTunnelArgs('u', 'h', 9222, 9222)).toEqual([
      '-L',
      '9222:127.0.0.1:9222',
      'u@h',
      '-N',
      ...SSH_OPTS,
    ]);
  });

  it('inherits the keepalive from the shared baseline', () => {
    const args = buildTunnelArgs('u', 'h', 9222, 9222);
    expect(args.join(' ')).toContain('ServerAliveInterval=15');
    expect(args.join(' ')).toContain('ServerAliveCountMax=3');
  });

  it('uses an explicit identity for a device tunnel', () => {
    const args = buildTunnelArgs('muqsit', 'win-mini', 55000, 8765, [
      '-i', '/keys/win-mini', '-o', 'IdentitiesOnly=yes',
    ]);
    expect(args).toContain('/keys/win-mini');
    expect(args).toContain('IdentitiesOnly=yes');
  });
});
