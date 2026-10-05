
import type { Command } from 'commander';
import chalk from 'chalk';

import { addHostOption } from '../lib/hosts/option.js';
import { setHelpSections } from '../lib/help.js';
import { resolveAgentName, AGENTS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { computeSnapshot, type FleetSnapshot } from '../lib/snapshot.js';
import { resolveSurface } from './utils.js';

interface SnapshotOptions {
  json?: boolean;
  allHosts?: boolean;
  withFeed?: boolean;
  withSync?: boolean;
  agent?: string;
}

function resolveAgentFilter(raw: string | undefined): AgentId | undefined {
  if (!raw) return undefined;
  const name = resolveAgentName(raw.split('@')[0]);
  if (!name) {
    console.error(chalk.red(`Unknown agent "${raw}".`));
    process.exit(1);
  }
  return name;
}

function renderHuman(snap: FleetSnapshot): void {
  console.log(chalk.bold('Fleet snapshot') + chalk.gray(`  ·  ${snap.host}  ·  ${snap.capturedAt}`));

  const invParts: string[] = [];
  for (const a of snap.inventory) {
    if (a.versions.length === 0) continue;
    const def = a.versions.find((v) => v.isDefault) ?? a.versions[0];
    const label = AGENTS[a.agent as AgentId]?.name ?? a.agent;
    const signed = def.signedIn ? chalk.green('in') : chalk.gray('out');
    invParts.push(`${label}@${def.version} (${signed})`);
  }
  console.log(
    `  ${'Inventory'.padEnd(12)} ${invParts.length ? invParts.join(chalk.gray(' · ')) : chalk.gray('(none installed)')}`,
  );

  const { running, live, byContext, byAgent } = snap.agents;
  const ctx = Object.entries(byContext)
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
  const ag = Object.entries(byAgent)
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
  console.log(
    `  ${'Sessions'.padEnd(12)} ${live} live · ${running} running` +
      (snap.remoteDeviceCount > 0 ? chalk.gray(` · ${snap.remoteDeviceCount} remote device(s)`) : '') +
      (ctx ? chalk.gray(` · ${ctx}`) : '') +
      (ag ? chalk.gray(` · ${ag}`) : ''),
  );

  if (snap.feed) {
    console.log(
      `  ${'Feed'.padEnd(12)} ${snap.feed.openBlocks} open block${snap.feed.openBlocks === 1 ? '' : 's'}`,
    );
  }
  if (snap.sync) {
    const need = snap.sync.agents.filter((a) => a.needsSync).length;
    const sys =
      snap.sync.system.unknown
        ? 'system unknown'
        : snap.sync.system.behind > 0
          ? `system ${snap.sync.system.behind} behind`
          : 'system ok';
    console.log(
      `  ${'Sync'.padEnd(12)} ${sys} · ${need} version${need === 1 ? '' : 's'} need sync`,
    );
  }

  console.log(
    chalk.gray(
      '\n  Machine-readable: agents devices snapshot --json\n' +
        '  Sync-only (unchanged): agents sync status --json',
    ),
  );
}

export function registerSnapshotCommand(devicesCmd: Command): void {
  const cmd = addHostOption(
    devicesCmd
      .command('snapshot')
      .description(
        'One-process poll snapshot: install inventory + active sessions (optional feed/sync). Not the sync-status command — use `agents sync status` for drift.',
      ),
  )
    .option('--json', 'Emit the machine-readable FleetSnapshot contract (version 1)')
    .option(
      '--all-hosts',
      'Include remote devices in the sessions gather (same fan-out as `sessions --active`; default is this machine only)',
    )
    .option('--with-feed', 'Include open feed-block summary (needs-you count + compact rows)')
    .option('--with-sync', 'Include UnifiedSyncStatus (same engine as `agents sync status`; opt-in)')
    .option('--agent <name>', 'Restrict inventory to one agent (e.g. claude)');

  setHelpSections(cmd, {
    examples: `
      # One-shot inventory + local active sessions (JSON)
      agents devices snapshot --json

      # Same, plus open feed blocks for needs-you polls
      agents devices snapshot --json --with-feed

      # Fleet-wide active sessions (matches sessions --active scope)
      agents devices snapshot --json --all-hosts

      # Inventory for one harness only (an AGI EXT-style usage poll)
      agents devices snapshot --json --agent claude

      # Run the whole snapshot on another device
      agents devices snapshot --json --device yosemite-s0
    `,
  });

  cmd.action(async (opts: SnapshotOptions, command: Command) => {
    const surface = resolveSurface(command);
    const agent = resolveAgentFilter(opts.agent);
    const snap = await computeSnapshot({
      agent,
      local: opts.allHosts !== true,
      withFeed: opts.withFeed === true,
      withSync: opts.withSync === true,
    });

    if (surface.json || opts.json) {
      console.log(JSON.stringify(snap, null, 2));
      return;
    }
    renderHuman(snap);
  });
}
