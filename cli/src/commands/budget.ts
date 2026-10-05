/** `agents config budget` views and sets spend caps (issue #346): bare shows effective caps and
 * spend-to-cap, `--json` a machine snapshot, `set <cap> <n>` writes the user agents.yaml budget:
 * block. Caps resolve project > user; the project layer is hand-edited in the repo's agents.yaml. */
import type { Command } from 'commander';
import chalk from 'chalk';

import type { AgentId, BudgetConfig } from '../lib/types.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { readMeta, updateMeta } from '../lib/state.js';
import { resolveBudgetConfig, hasAnyCap } from '../lib/budget/config.js';
import { loadLedger, spendForDay, spendForProject, spendForAgentDay, localDay } from '../lib/budget/ledger.js';
import { formatUsd } from '../lib/pricing/index.js';

const TOP_CAPS = ['per_run', 'per_day', 'per_project'] as const;

export function registerBudgetCommand(configCmd: Command): void {
  const budgetCmd = configCmd
    .command('budget')
    .description('Show spend caps and current spend-to-cap (issue #346)')
    .option('--json', 'Emit the budget + spend snapshot as JSON')
    .action((options: { json?: boolean }) => {
      const cwd = process.cwd();
      const cfg = resolveBudgetConfig(cwd);
      const ledger = loadLedger();
      const today = localDay();
      const daySpend = spendForDay(today, ledger);
      const projectSpend = spendForProject(cwd, ledger);

      const perAgentSpend: Record<string, number> = {};
      if (cfg.per_agent) {
        for (const agent of Object.keys(cfg.per_agent)) {
          perAgentSpend[agent] = spendForAgentDay(agent, today, ledger);
        }
      }

      if (options.json) {
        console.log(JSON.stringify({
          currency: cfg.currency ?? 'USD',
          on_exceed: cfg.on_exceed ?? 'block',
          require_confirm_over: cfg.require_confirm_over ?? null,
          caps: {
            per_run: cfg.per_run ?? null,
            per_day: cfg.per_day ?? null,
            per_project: cfg.per_project ?? null,
            per_agent: cfg.per_agent ?? {},
          },
          spend: {
            day: daySpend,
            project: projectSpend,
            per_agent_day: perAgentSpend,
          },
          configured: hasAnyCap(cfg),
          project: cwd,
          day: today,
        }, null, 2));
        return;
      }

      console.log(renderBudget(cfg, { daySpend, projectSpend, perAgentSpend, project: cwd, day: today }));
    });

  budgetCmd
    .command('set <cap> <amount>')
    .description(`Set a user-global cap. <cap> = ${TOP_CAPS.join(' | ')} | per_agent.<agent> | on_exceed | require_confirm_over`)
    .addHelpText('after', `
Examples:
  agents config budget set per_run 5            Cap any single run at $5
  agents config budget set per_day 50           Cap total spend per day at $50
  agents config budget set per_agent.claude 30  Cap Claude's daily spend at $30
  agents config budget set on_exceed warn       Switch to warn-only (do not block)
`)
    .action((cap: string, amount: string) => {
      const meta = readMeta();
      const current: BudgetConfig = { ...(meta.budget ?? {}) };

      if (cap === 'on_exceed') {
        if (amount !== 'block' && amount !== 'warn') {
          console.error(chalk.red(`on_exceed must be 'block' or 'warn'.`));
          process.exit(1);
        }
        current.on_exceed = amount;
      } else if (cap.startsWith('per_agent.')) {
        const agent = cap.slice('per_agent.'.length);
        if (!ALL_AGENT_IDS.includes(agent as AgentId)) {
          console.error(chalk.red(`Unknown agent '${agent}'. Known: ${ALL_AGENT_IDS.join(', ')}`));
          process.exit(1);
        }
        const value = parseAmount(amount);
        current.per_agent = { ...(current.per_agent ?? {}), [agent as AgentId]: value };
      } else if ((TOP_CAPS as readonly string[]).includes(cap) || cap === 'require_confirm_over') {
        const value = parseAmount(amount);
        (current as Record<string, unknown>)[cap] = value;
      } else {
        console.error(chalk.red(`Unknown cap '${cap}'. Use: ${TOP_CAPS.join(', ')}, per_agent.<agent>, on_exceed, require_confirm_over.`));
        process.exit(1);
      }

      updateMeta((m) => ({ ...m, budget: current }));
      console.log(chalk.green(`Set budget.${cap} = ${amount}`));
    });
}

function parseAmount(amount: string): number {
  const value = Number(amount.replace(/^\$/, ''));
  if (!Number.isFinite(value) || value < 0) {
    console.error(chalk.red(`Invalid amount '${amount}'. Use a non-negative number (e.g. 5 or 5.00).`));
    process.exit(1);
  }
  return value;
}

interface SpendSnapshot {
  daySpend: number;
  projectSpend: number;
  perAgentSpend: Record<string, number>;
  project: string;
  day: string;
}

function capLine(label: string, spend: number | null, cap: number | undefined): string {
  if (cap === undefined) {
    return `  ${label.padEnd(14)} ${chalk.dim('(unset)')}`;
  }
  const spent = spend ?? 0;
  const ratio = cap > 0 ? Math.min(spent / cap, 1) : 0;
  const bars = Math.round(ratio * 10);
  const bar = '▮'.repeat(bars) + '▯'.repeat(10 - bars);
  const color = ratio >= 1 ? chalk.red : ratio >= 0.8 ? chalk.yellow : chalk.green;
  const figure = spend === null ? formatUsd(cap) : `${formatUsd(spent)} / ${formatUsd(cap)}`;
  return `  ${label.padEnd(14)} ${color(figure.padEnd(18))} ${color(bar)}`;
}

function renderBudget(cfg: BudgetConfig, snap: SpendSnapshot): string {
  const lines: string[] = [];
  lines.push(chalk.bold('Budget') + chalk.dim(`  (on_exceed: ${cfg.on_exceed ?? 'block'}, currency: ${cfg.currency ?? 'USD'})`));
  lines.push(chalk.dim(`  project: ${snap.project}`));
  lines.push(chalk.dim(`  day:     ${snap.day}`));
  lines.push('');

  if (!hasAnyCap(cfg)) {
    lines.push(chalk.dim('  No caps configured. Set one with: agents config budget set per_run 5'));
    return lines.join('\n');
  }

  lines.push(capLine('per_run', null, cfg.per_run));
  lines.push(capLine('per_day', snap.daySpend, cfg.per_day));
  lines.push(capLine('per_project', snap.projectSpend, cfg.per_project));

  if (cfg.per_agent && Object.keys(cfg.per_agent).length > 0) {
    lines.push('');
    lines.push(chalk.bold('Per-agent (today)'));
    for (const [agent, cap] of Object.entries(cfg.per_agent)) {
      lines.push(capLine(agent, snap.perAgentSpend[agent] ?? 0, cap));
    }
  }

  if (cfg.require_confirm_over !== undefined) {
    lines.push('');
    lines.push(chalk.dim(`  confirm prompt over: ${formatUsd(cfg.require_confirm_over)}`));
  }

  return lines.join('\n');
}
