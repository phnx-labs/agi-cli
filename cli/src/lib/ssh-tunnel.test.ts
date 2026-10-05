import { describe, expect, it } from 'vitest';
import { buildTunnelArgs, startSSHTunnel } from './ssh-tunnel.js';
import { SSH_OPTS } from './ssh-exec.js';

describe('startSSHTunnel — target validation', () => {
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
    expect(args).toContain('-L');
    expect(args).toContain('55000:127.0.0.1:8765');
    expect(args).toContain('muqsit@win-mini');
    expect(args).toContain('-N');
    expect(args.join(' ')).toContain('StrictHostKeyChecking=accept-new');
    expect(args.join(' ')).toContain('BatchMode=yes');
    expect(args.join(' ')).toContain('ConnectTimeout=10');
  });

  it('is the -L mapping + target + -N followed by the shared hardened baseline', () => {
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
