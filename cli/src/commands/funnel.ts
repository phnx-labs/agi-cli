import type { Command } from 'commander';
import chalk from 'chalk';
import { buildFunnelDownCommand, buildFunnelStatusCommand, buildFunnelUpCommand, parseFunnelPort } from '../lib/funnel.js';
import { resolveHost } from '../lib/hosts/registry.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { sshExec } from '../lib/ssh-exec.js';

async function resolveIngressHost(name: string) {
  const host = await resolveHost(name);
  if (!host) throw new Error(`Unknown host "${name}". Enroll it with agents hosts add, or sync devices first.`);
  const os = host.os ?? resolveRemoteOsSync(host.name);
  if (os === 'windows') {
    throw new Error('Tailscale Funnel requires a host with the Tailscale CLI; Windows cannot host this ingress path.');
  }
  return host;
}

async function runOnHost(hostName: string, command: string): Promise<void> {
  const host = await resolveIngressHost(hostName);
  const target = sshTargetFor(host);
  const result = sshExec(target, command, { timeoutMs: 30_000, multiplex: true });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `ssh exited ${result.code ?? 'without a code'}`);
  }
  const out = result.stdout.trim();
  if (out) console.log(out);
}

export function registerFunnelCommand(program: Command): void {
  const funnel = program
    .command('funnel')
    .description('Manage Tailscale Funnel exposure for a fleet webhook receiver.');

  funnel
    .command('status <host>')
    .description('Show Tailscale Funnel status on a fleet host.')
    .action(async (host: string) => {
      try {
        await runOnHost(host, buildFunnelStatusCommand());
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  funnel
    .command('up <host>')
    .description('Expose a localhost webhook receiver through Tailscale Funnel.')
    .requiredOption('--local-port <n>', 'Local receiver port on the remote host')
    .option('--port <n>', 'Public Funnel port: 443, 8443, or 10000', '443')
    .action(async (host: string, opts: { port?: string; localPort: string }) => {
      try {
        const publicPort = parseFunnelPort(opts.port ?? '443');
        const localPort = Number.parseInt(opts.localPort, 10);
        const command = buildFunnelUpCommand(publicPort, localPort);
        await runOnHost(host, command);
        console.log(chalk.green(`Funnel enabled on ${host}: public :${publicPort} → localhost:${localPort}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  funnel
    .command('down <host>')
    .description('Disable Tailscale Funnel exposure for a public HTTPS port.')
    .option('--port <n>', 'Public Funnel port: 443, 8443, or 10000', '443')
    .action(async (host: string, opts: { port?: string }) => {
      try {
        const publicPort = parseFunnelPort(opts.port ?? '443');
        await runOnHost(host, buildFunnelDownCommand(publicPort));
        console.log(chalk.green(`Funnel disabled on ${host}: public :${publicPort}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
