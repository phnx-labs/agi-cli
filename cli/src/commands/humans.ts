
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { readHumans, getOwnerFromHumans } from '../lib/humans.js';

export function registerHumansCommands(program: Command): void {
  const humansCmd = program
    .command('humans')
    .description('Inspect owner identity and notification channel config (humans.yaml)');

  setHelpSections(humansCmd, {
    examples: `
      # Show owner identity and channel config as JSON
      agents humans show owner --json

      # Show owner identity in human-readable form
      agents humans show owner
    `,
    notes: `
      humans.yaml is the canonical owner identity file at ~/.agents/humans.yaml.
      It is populated by migrating notify.owner from agents.yaml and frontmatter
      from owner.md. Use \`agents humans show owner\` to inspect the current config.
    `,
  });

  const showCmd = humansCmd
    .command('show')
    .description('Show config from humans.yaml');

  setHelpSections(showCmd, {
    examples: `
      agents humans show owner
      agents humans show owner --json
    `,
  });

  showCmd
    .command('owner')
    .description('Show the configured owner identity and notification channels')
    .option('--json', 'Output as JSON')
    .action((opts: { json?: boolean }) => {
      const humans = readHumans();
      if (!humans) {
        if (opts.json) {
          process.stdout.write(JSON.stringify(null) + '\n');
        } else {
          process.stderr.write('humans.yaml not found — run `agents` once to trigger migration\n');
          process.exitCode = 1;
        }
        return;
      }

      const owner = getOwnerFromHumans();
      if (opts.json) {
        process.stdout.write(JSON.stringify(owner ?? null, null, 2) + '\n');
      } else {
        if (!owner) {
          process.stdout.write('No owner configured in humans.yaml\n');
          return;
        }
        if (owner.name) process.stdout.write(`Name:     ${owner.name}\n`);
        if (owner.timezone) process.stdout.write(`Timezone: ${owner.timezone}\n`);
        if (owner.quiet_hours) process.stdout.write(`Quiet:    ${owner.quiet_hours}\n`);
        if (owner.default_severity) process.stdout.write(`Severity: ${owner.default_severity}\n`);
        if (owner.notify) {
          process.stdout.write(`Notify:   channel=${owner.notify.channel} to=${owner.notify.to}\n`);
        }
        if (owner.channels?.length) {
          process.stdout.write(`Channels:\n`);
          for (const ch of owner.channels) {
            const extra = [ch.transport, ch.intrusive ? 'intrusive' : null].filter(Boolean).join(', ');
            process.stdout.write(`  - ${ch.id}${extra ? ` (${extra})` : ''}\n`);
          }
        }
        if (owner.policy) {
          process.stdout.write(`Policy:\n`);
          for (const [sev, channels] of Object.entries(owner.policy)) {
            if (Array.isArray(channels) && channels.length) {
              process.stdout.write(`  ${sev}: ${channels.join(', ')}\n`);
            }
          }
        }
      }
    });
}
