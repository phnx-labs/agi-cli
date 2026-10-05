
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import * as yaml from 'yaml';
import { loadDevices } from '../lib/devices/registry.js';
import { readMeta, updateMeta, getDevicePinsPath } from '../lib/state.js';
import { machineId } from '../lib/machine-id.js';
import { listBundles, SecretsClientError } from '../lib/secrets-client.js';
import { listJobs } from '../lib/scheduling/routines.js';
import { captureFleet, type CaptureInputs } from '../lib/fleet/capture.js';
import type { FleetDefaults } from '../lib/fleet/types.js';

interface CaptureOptions {
  dryRun?: boolean;
  fromPins?: boolean;
  device?: string;
}

function agentsFromPins(names: string[]): Record<string, string[]> {
  const self = machineId();
  if (!names.includes(self)) return {};
  let pins: { agents?: Record<string, unknown> };
  try {
    pins = JSON.parse(fs.readFileSync(getDevicePinsPath(), 'utf-8')) as typeof pins;
  } catch {
    return {};
  }
  const ids = pins?.agents ? Object.keys(pins.agents) : [];
  return ids.length > 0 ? { [self]: ids.map((id) => `${id}@latest`) } : {};
}

async function captureSecretsBundleNames(): Promise<string[]> {
  try {
    return (await listBundles()).map((b) => b.name);
  } catch (err) {
    if (err instanceof SecretsClientError && err.code === 'SECRETS_BIN_MISSING') {
      console.error(chalk.yellow('warning: standalone `secrets` CLI not installed — capturing with no secrets bundles.'));
      return [];
    }
    throw err;
  }
}

async function runCapture(opts: CaptureOptions): Promise<void> {
  const meta = readMeta();

  const registry = await loadDevices();
  let names = Object.values(registry)
    .map((d) => d.name)
    .sort();
  if (opts.device) {
    names = names.filter((n) => n === opts.device);
    if (names.length === 0) throw new Error(`Device '${opts.device}' is not a registered device.`);
    if (opts.fromPins && opts.device !== machineId()) {
      throw new Error(
        `--from-pins can only read THIS machine's pins ('${machineId()}') — peer pins are machine-local and never sync. Run it on '${opts.device}' itself, or drop --device.`,
      );
    }
  }

  const sourceAgents = Object.keys(meta.agents ?? {}).sort();
  const defaults: FleetDefaults = {
    agents: sourceAgents.map((id) => `${id}@latest`),
    sync: ['user'],
    login: 'sync',
  };

  const inputs: CaptureInputs = {
    devices: names,
    defaults,
    agentsByDevice: opts.fromPins ? agentsFromPins(names) : undefined,
    secretsBundles: await captureSecretsBundleNames(),
    routines: listJobs().map((j) => j.name),
  };

  const next = captureFleet(meta.fleet, inputs);

  if (opts.dryRun) {
    console.log(chalk.gray('# agents.yaml fleet: block (dry run — not written)'));
    console.log(yaml.stringify({ fleet: next }).trimEnd());
    return;
  }

  updateMeta((m) => ({ ...m, fleet: next }));
  const deviceCount = Object.keys(next.devices === 'all' ? {} : next.devices).length;
  console.log(
    chalk.green('Captured fleet profile') +
      chalk.gray(
        ` — ${deviceCount} device(s), ${defaults.agents?.length ?? 0} agent(s), ` +
          `${inputs.secretsBundles?.length ?? 0} secret bundle(s), ${inputs.routines?.length ?? 0} routine(s).`,
      ),
  );
  console.log(chalk.gray('  Wrote agents.yaml → fleet:. Push it (`agents repo push`) and run `agents fleet apply` on any machine.'));
}

export function registerFleetCaptureCommand(devicesCmd: Command): void {
  devicesCmd
    .command('capture')
    .description('Snapshot the live environment (roster names, agents, browser, secret-bundle names, routines) into agents.yaml fleet:.')
    .option('--dry-run', 'print the fleet: block that would be written, and exit')
    .option('--from-pins', "record THIS machine's pinned agents (peer pins are machine-local and never sync)")
    .option('--device <name>', 'capture a single device')
    .action(async (opts: CaptureOptions) => {
      try {
        await runCapture(opts);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exit(1);
      }
    });
}
