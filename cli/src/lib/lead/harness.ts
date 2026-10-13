import { getCliLaunch } from '../cli-entry.js';
import { configKeySpec, getConfigValue } from '../device-config.js';

export const LEAD_ALLOWED_TOOLS = [
  'Bash(agents ps:*)',
  'Bash(agents send:*)',
  'Bash(agents run:*)',
  'Bash(agents feed:*)',
  'Bash(sessions:*)',
  'Bash(artifacts list:*)',
  'Bash(linear:*)',
  'Bash(jq:*)',
] as const;

export const LEAD_DENIED_TOOLS = [
  'Bash(agents ps stop:*)',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
] as const;

export const LEAD_EFFORT = 'low';

export interface Launch {
  command: string;
  args: string[];
}

export type LeadSessionStart = { mode: 'fresh'; sessionId: string } | { mode: 'resume'; sessionId: string };

export function leadModel(): string {
  const value = getConfigValue('lead.model').value;
  return typeof value === 'string' && value.length > 0 ? value : String(configKeySpec('lead.model').defaultValue);
}

export function leadRunArgs(project: string, model: string, start: LeadSessionStart): string[] {
  const session = start.mode === 'fresh'
    ? ['--session-id', start.sessionId, '--name', `lead-${project}`]
    : ['--resume', start.sessionId];
  return [
    'run', 'claude', '--headless', '--quiet',
    '-P', project,
    '--model', model,
    '--effort', LEAD_EFFORT,
    ...session,
    '--',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', 'Bash',
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...LEAD_ALLOWED_TOOLS,
    '--disallowedTools', ...LEAD_DENIED_TOOLS,
  ];
}

export function agentsCliLaunch(args: string[]): Launch {
  return getCliLaunch(args);
}
