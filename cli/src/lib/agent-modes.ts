
import type { AgentId, Mode } from './types.js';
import { ALL_MODES } from './types.js';
import { AGENTS } from './agents.js';
import { AGENT_COMMANDS, defaultModeFor } from './exec.js';
import { resolveRunDefaults } from './run-defaults.js';

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  plan: 'read-only investigation; no writes, no shell side-effects',
  edit: 'may edit files; prompts for shell / risky operations',
  auto: 'more autonomy than edit; the exact policy is per-harness (see notes)',
  skip: 'bypass every permission prompt (dangerously-skip-permissions)',
};

const AUTO_SEMANTICS: Partial<Record<AgentId, string>> = {
  claude: 'a smart classifier auto-approves safe operations and still prompts for risky ones.',
  copilot: 'a smart classifier auto-approves safe operations and still prompts for risky ones.',
  codex: 'approval_policy=never over the same sandbox as edit — it never prompts, and a sandbox-denied command fails instead of raising an approval request.',
  muse: 'runs --disable-approval, which turns approvals off while keeping the sandbox — like codex, it never prompts and a denied command fails.',
  droid: 'runs --auto high, droid\'s full-autonomy setting.',
  kimi: "runs kimi's native --auto.",
};

export interface AgentModeEntry {
  mode: Mode;
  flags: string[];
  description: string;
  isDefault: boolean;
}

export interface AgentModesCatalog {
  agent: AgentId;
  modes: AgentModeEntry[];
  defaultMode: Mode;
  configuredMode: Mode | null;
  configuredModeSource: string | null;
  headlessPlan: boolean;
  unsupported: Mode[];
  notes: string[];
}

export function getAgentModesCatalog(
  agent: AgentId,
  version?: string | null,
  cwd: string = process.cwd(),
): AgentModesCatalog {
  const supported = AGENTS[agent].capabilities.modes;
  const defaultMode = defaultModeFor(agent);
  const modeFlags = AGENT_COMMANDS[agent]?.modeFlags ?? {};
  const headlessPlan = AGENTS[agent].capabilities.headlessPlan !== false;

  const modes: AgentModeEntry[] = supported.map((mode) => ({
    mode,
    flags: modeFlags[mode] ?? [],
    description: MODE_DESCRIPTIONS[mode],
    isDefault: mode === defaultMode,
  }));

  const unsupported = ALL_MODES.filter((m) => !supported.includes(m));

  const runDefaults = resolveRunDefaults(agent, version, cwd);
  const configuredMode = runDefaults.mode ?? null;
  const configuredModeSource = runDefaults.sources.mode ?? null;

  const notes: string[] = [];
  notes.push(`'full' is accepted as a silent alias for 'skip'.`);
  if (unsupported.includes('auto')) {
    notes.push(`--mode auto degrades to edit on ${agent} (no native auto classifier).`);
  }
  const autoSemantics = AUTO_SEMANTICS[agent];
  if (autoSemantics && supported.includes('auto')) {
    notes.push(`${agent} --mode auto: ${autoSemantics}`);
  }
  if (unsupported.includes('plan')) {
    notes.push(`--mode plan degrades to ${defaultMode} on ${agent} (no native read-only mode).`);
  }
  if (!headlessPlan && supported.includes('plan')) {
    notes.push(
      `headless --mode plan is not supported on ${agent}; a prompt-based plan run auto-downgrades (see resolveHeadlessMode).`,
    );
  }
  if (unsupported.includes('skip')) {
    notes.push(`${agent} has no skip/full bypass mode.`);
  }

  return {
    agent,
    modes,
    defaultMode,
    configuredMode,
    configuredModeSource,
    headlessPlan,
    unsupported: [...unsupported],
    notes,
  };
}

export function formatModeFlags(flags: string[]): string {
  if (flags.length === 0) return '(harness default)';
  return flags.join(' ');
}
