import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCliLaunch } from '../cli-entry.js';
import { atomicWriteFileSync, atomicWriteJsonSync } from '../fs-atomic.js';
import { configKeySpec, getConfigValue } from '../device-config.js';
import type { LeadPaths } from './paths.js';

export const LEAD_TOOL_NAMES = ['roster', 'dispatch', 'start', 'send', 'stop', 'linear', 'remember'] as const;
export type LeadToolName = typeof LEAD_TOOL_NAMES[number];

export const LEAD_ALLOWED_TOOLS: readonly string[] = LEAD_TOOL_NAMES.map((name) => `Bash(agents lead tool ${name}:*)`);

export const LEAD_DENIED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] as const;

export const LEAD_EFFORT = 'low';

export const LEAD_ENV_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'TERM'] as const;
const LEAD_ENV_AUTH = /^(ANTHROPIC_[A-Z_]+|CLAUDE_CODE_OAUTH_TOKEN)$/;

export interface Launch {
  command: string;
  args: string[];
}

export type LeadSessionStart = { mode: 'fresh'; sessionId: string } | { mode: 'resume'; sessionId: string };

export function leadModel(): string {
  const value = getConfigValue('lead.model').value;
  return typeof value === 'string' && value.length > 0 ? value : String(configKeySpec('lead.model').defaultValue);
}

export function cliVersion(): string {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
  return (JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { version: string }).version;
}

export function leadSettings(): Record<string, unknown> {
  return {
    permissions: {
      allow: [...LEAD_ALLOWED_TOOLS],
      deny: [...LEAD_DENIED_TOOLS],
      defaultMode: 'dontAsk',
    },
    hooks: {},
    disableAllHooks: true,
  };
}

export function writeLeadSettings(paths: LeadPaths): string {
  atomicWriteJsonSync(paths.settings, leadSettings());
  return paths.settings;
}

export function writeAgentsShim(paths: LeadPaths, launch: Launch = getCliLaunch([])): string {
  fs.mkdirSync(paths.bin, { recursive: true, mode: 0o700 });
  const file = path.join(paths.bin, 'agents');
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  atomicWriteFileSync(file, `#!/bin/sh\nexec ${[launch.command, ...launch.args].map(quote).join(' ')} "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

export function leadChildEnv(project: string, paths: LeadPaths, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LEAD_ENV_PASSTHROUGH) if (source[key] !== undefined) env[key] = source[key];
  for (const [key, value] of Object.entries(source)) if (LEAD_ENV_AUTH.test(key) && value !== undefined) env[key] = value;
  env.PATH = [paths.bin, env.PATH].filter(Boolean).join(path.delimiter);
  env.AGENTS_LEAD_PROJECT = project;
  env.AGENTS_NO_AUTOPULL = '1';
  return env;
}

export const WORKER_ENV_PASSTHROUGH = [
  ...LEAD_ENV_PASSTHROUGH,
  'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS', 'COLORTERM', 'EDITOR', 'VISUAL',
] as const;

function curatedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) if (LEAD_ENV_AUTH.test(key) && value !== undefined) env[key] = value;
  return env;
}

export function workerEnv(source: NodeJS.ProcessEnv, leadRootDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = curatedEnv(source);
  if (env.PATH) {
    env.PATH = env.PATH.split(path.delimiter).filter((dir) => dir && !path.resolve(dir).startsWith(path.resolve(leadRootDir))).join(path.delimiter);
  }
  return env;
}

export function leadRunArgs(project: string, model: string, start: LeadSessionStart, paths: LeadPaths): string[] {
  const session = start.mode === 'fresh'
    ? ['--session-id', start.sessionId, '--name', `lead-${project}`]
    : ['--resume', start.sessionId];
  return [
    'run', 'claude', '--headless', '--quiet',
    '--cwd', paths.dir,
    '--model', model,
    '--effort', LEAD_EFFORT,
    ...session,
    '--',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--setting-sources', 'local',
    '--settings', paths.settings,
    '--strict-mcp-config',
    '--tools', 'Bash',
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...LEAD_ALLOWED_TOOLS,
    '--disallowedTools', ...LEAD_DENIED_TOOLS,
  ];
}

export function agentsCliLaunch(args: string[]): Launch {
  return getCliLaunch(args);
}
