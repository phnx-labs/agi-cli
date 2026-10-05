/** `agents packages materialize` (PHNX-3838): resolve the schema-v3 package via
 * resolveAgentPackage, project it into an ephemeral home via materializeAgentPackage. The front
 * door owns only the harness allowlist, an exact version, and refusing live harness homes. */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die, isJsonMode } from '../lib/format.js';
import { setHelpSections } from '../lib/help.js';
import {
  resolveAgentPackage,
  materializeAgentPackage,
  AgentPackageError,
  type MaterializationReceipt,
} from '../lib/agent-spec/index.js';
import {
  MaterializeGuardError,
  PORTABLE_HARNESSES,
  assertExactHarnessVersion,
  assertPortableHarness,
  resolveOutputHome,
} from '../lib/packages/output-home.js';

export { PORTABLE_HARNESSES };
export type { MaterializationReceipt };

function printReceipt(receipt: MaterializationReceipt, outputHome: string): void {
  console.log(chalk.bold(`Materialized ${receipt.agent.ref} → ${receipt.harness.id}@${receipt.harness.version}`));
  console.log(`  digest       ${receipt.agent.digest}`);
  console.log(`  output home  ${outputHome}`);
  for (const entry of receipt.resources) {
    console.log(`  ${entry.kind.padEnd(12)} ${entry.name}  →  ${entry.target}`);
  }
  if (receipt.warnings.length > 0) {
    console.log(chalk.yellow('  warnings'));
    for (const warning of receipt.warnings) console.log(chalk.yellow(`    ${warning}`));
  }
}

function fail(err: unknown, json: boolean): never {
  if (err instanceof MaterializeGuardError || err instanceof AgentPackageError) {
    die(err.message, 1, { json });
  }
  die(err instanceof Error ? err.message : String(err), 1, { json });
}

/** Register `agents packages materialize`. */
export function registerPortablePackageCommands(program: Command): void {
  const packagesCmd = program
    .command('packages')
    .description('Portable agent packages — materialize schema-v3 agent.yaml into an ephemeral harness home');

  setHelpSections(packagesCmd, {
    examples: `
      # Materialize a package into an ephemeral Claude home
      agents packages materialize ./reviewer --harness claude --harness-version 2.1.0 --output-home /tmp/reviewer-claude

      # Machine-readable receipt for Factory / Prix Cloud
      agents packages materialize ./reviewer --harness codex --harness-version 0.42.0 --output-home "$OUTPUT_HOME" --json

      # OpenCode worker on a Factory box
      agents packages materialize ./reviewer --harness opencode --harness-version 1.0.0 --output-home "$OUTPUT_HOME" --json
    `,
    notes: `
      Materialize writes only under --output-home. It never mutates ~/.claude,
      ~/.codex, or ~/.opencode, never copies secrets, and never execs a harness.

      Factory usage: point --output-home at the worker's ephemeral home and pass
      --json so the orchestrator can read the receipt (agent ref + digest,
      harness, per-resource targets, warnings).
    `,
  });

  const materializeCmd = packagesCmd
    .command('materialize <package>')
    .description('Materialize a schema-v3 agent.yaml package into an ephemeral Claude, Codex, or OpenCode home')
    .requiredOption('--harness <id>', `Target harness: ${PORTABLE_HARNESSES.join(', ')}`)
    .requiredOption(
      '--harness-version <version>',
      'Exact harness version to gate capabilities and stamp on the receipt (not --version: that is the CLI version flag)',
    )
    .requiredOption('--output-home <dir>', 'Ephemeral home to write into (must not escape or target the live user home)')
    .option('--json', 'Emit the materialization receipt as JSON')
    .action((pkg: string, opts: { harness: string; harnessVersion: string; outputHome: string; json?: boolean }) => {
      const json = isJsonMode(opts);
      try {
        const harness = assertPortableHarness(opts.harness);
        const harnessVersion = assertExactHarnessVersion(opts.harnessVersion);
        const outputHome = resolveOutputHome(opts.outputHome);
        const resolved = resolveAgentPackage(pkg);
        const receipt = materializeAgentPackage(resolved, { harness, harnessVersion, outputHome });
        if (json) {
          // Verbatim canonical receipt — byte-identical to the
          // materialization-receipt.json the materializer wrote into the home.
          console.log(JSON.stringify(receipt, null, 2));
          return;
        }
        printReceipt(receipt, outputHome);
      } catch (err) {
        fail(err, json);
      }
    });

  setHelpSections(materializeCmd, {
    examples: `
      agents packages materialize ./reviewer --harness claude --harness-version 2.1.0 --output-home /tmp/reviewer-claude
      agents packages materialize ./reviewer --harness codex --harness-version 0.42.0 --output-home "$OUTPUT_HOME" --json
      agents packages materialize ./reviewer --harness opencode --harness-version 1.0.0 --output-home "$OUTPUT_HOME" --json
    `,
    notes: `
      Factory / Prix Cloud: materialize into the worker's ephemeral home, then
      exec the harness with HOME=$OUTPUT_HOME. The --json receipt is the handoff.

      Supported harnesses: claude, codex, opencode. Any other id fails as an
      unsupported capability. A package must be a directory containing agent.yaml
      with schema_version: 3 and an execution block declaring the harness.
    `,
  });
}
