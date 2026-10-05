import type { Command } from 'commander';
import chalk from 'chalk';
import {
  ALL_BETA_FEATURES,
  getBetaConfigLocation,
  getEnabledBetaFeatures,
  setBetaEnabled,
} from '../lib/beta.js';
import type { BetaFeatureName } from '../lib/types.js';
import { setHelpSections } from '../lib/help.js';

const BETA_DESCRIPTIONS: Record<BetaFeatureName, string> = {
  factory: 'Cloud-based agent dispatch via Rush Factory',
};

const GRADUATED_FEATURES = new Set<string>(['projects']);

function parseFeatures(values: string[]): BetaFeatureName[] {
  const valid = new Set<BetaFeatureName>(ALL_BETA_FEATURES);
  for (const g of values.filter((v) => GRADUATED_FEATURES.has(v))) {
    console.error(chalk.gray(`'${g}' has graduated out of beta — it is on by default; no action needed.`));
  }
  const unknown = values.filter((v) => !valid.has(v as BetaFeatureName) && !GRADUATED_FEATURES.has(v));
  if (unknown.length > 0) {
    console.error(chalk.red(`Unknown beta feature: ${unknown.join(', ')}`));
    console.error(chalk.gray(`Valid features: ${ALL_BETA_FEATURES.join(', ')}`));
    process.exit(1);
  }
  return values.filter((v) => valid.has(v as BetaFeatureName)) as BetaFeatureName[];
}

export function registerBetaCommands(setupCmd: Command): void {
  const beta = setupCmd
    .command('beta')
    .description('Enable or disable preview features like factory.');

  setHelpSections(beta, {
    examples: `
      agents setup beta list
      agents setup beta enable factory
      agents setup beta disable factory
    `,
    notes: `
      Writes the enabled set to ~/.agents/agents.yaml (beta.enabled). Top-level
      \`agents beta\` is gone — use this group.
    `,
  });

  beta
    .command('list')
    .description('Show available beta features and whether they are enabled.')
    .action(() => {
      const enabled = new Set(getEnabledBetaFeatures());
      const location = getBetaConfigLocation();
      console.log(chalk.bold('Beta Features'));
      for (const feature of ALL_BETA_FEATURES) {
        const state = enabled.has(feature) ? chalk.green('enabled') : chalk.gray('disabled');
        const desc = BETA_DESCRIPTIONS[feature] || '';
        console.log(`  ${feature.padEnd(10)} ${state.padEnd(18)} ${chalk.dim(desc)}`);
      }
      console.log('');
      console.log(chalk.gray(`Config: ${location.path}`));
    });

  beta
    .command('enable <features...>')
    .description('Enable one or more beta features.')
    .action((features: string[]) => {
      const parsed = parseFeatures(features);
      if (parsed.length === 0) return;
      const result = setBetaEnabled(parsed, true);
      console.log(chalk.green(`Enabled: ${parsed.join(', ')}`));
      console.log(chalk.gray(`Saved to ${result.path}`));
    });

  beta
    .command('disable <features...>')
    .description('Disable one or more beta features.')
    .action((features: string[]) => {
      const parsed = parseFeatures(features);
      if (parsed.length === 0) return;
      const result = setBetaEnabled(parsed, false);
      console.log(chalk.green(`Disabled: ${parsed.join(', ')}`));
      console.log(chalk.gray(`Saved to ${result.path}`));
    });
}

