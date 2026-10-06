import { installCli, installedCliVersion, type CliManifest } from './cli-resources.js';
import { compareVersions } from './agent-spec/primitives.js';
import { SECRETS_CLI_PACKAGE, SECRETS_CLI_VERSION } from './secrets-cli.js';
import { invocation } from './secrets-client.js';

export const STANDALONE_TOOLS = ['sessions', 'browser', 'secrets', 'computer', 'term'] as const;
export type StandaloneTool = typeof STANDALONE_TOOLS[number];

export interface StandaloneToolPin {
  tool: StandaloneTool;
  pkg: string;
  floor: string;
}

export const STANDALONE_TOOL_PINS: Readonly<Record<StandaloneTool, StandaloneToolPin>> = {
  sessions: { tool: 'sessions', pkg: '@phnx-labs/sessions-cli', floor: '0.5.0' },
  browser: { tool: 'browser', pkg: '@phnx-labs/browser-cli', floor: '0.1.15' },
  secrets: { tool: 'secrets', pkg: SECRETS_CLI_PACKAGE, floor: SECRETS_CLI_VERSION },
  computer: { tool: 'computer', pkg: '@phnx-labs/computer-cli', floor: '0.1.5' },
  term: { tool: 'term', pkg: '@phnx-labs/term-cli', floor: '0.1.0' },
};

export function pinnedSpec(tool: StandaloneTool): string {
  const pin = STANDALONE_TOOL_PINS[tool];
  return `${pin.pkg}@${pin.floor}`;
}

function explicitBin(tool: StandaloneTool): string | null {
  return tool === 'secrets' ? process.env.SECRETS_BIN?.trim() || null : null;
}

function pinManifest(tool: StandaloneTool): CliManifest {
  const bin = explicitBin(tool);
  const { command, prefix } = bin ? invocation(bin) : { command: tool, prefix: [] };
  return {
    name: tool,
    check: { kind: 'version', cmd: command, args: [...prefix, '--version'] },
    install: [{ npm: pinnedSpec(tool) }],
    source: 'builtin',
    path: '',
  };
}

export interface ToolPinRow {
  tool: StandaloneTool;
  pkg: string;
  floor: string;
  installed: string | null;
  state: 'ok' | 'missing' | 'outdated' | 'installed' | 'upgraded' | 'failed';
  error?: string;
}

export function meetsFloor(installed: string | null, floor: string): boolean {
  return installed !== null && compareVersions(installed, floor) >= 0;
}

export async function readToolPins(tools: readonly StandaloneTool[] = STANDALONE_TOOLS): Promise<ToolPinRow[]> {
  return Promise.all(tools.map(async (tool) => {
    const pin = STANDALONE_TOOL_PINS[tool];
    const installed = await installedCliVersion(pinManifest(tool));
    const state: ToolPinRow['state'] = meetsFloor(installed, pin.floor) ? 'ok' : installed === null ? 'missing' : 'outdated';
    return { tool, pkg: pin.pkg, floor: pin.floor, installed, state };
  }));
}

export async function ensureToolPins(
  opts: { tools?: readonly StandaloneTool[]; dryRun?: boolean; logToStderr?: boolean } = {},
): Promise<ToolPinRow[]> {
  const before = await readToolPins(opts.tools);
  const out: ToolPinRow[] = [];
  for (const row of before) {
    if (row.state === 'ok' || opts.dryRun) {
      out.push(row);
      continue;
    }
    const bin = explicitBin(row.tool);
    if (bin) {
      out.push({ ...row, state: 'failed', error: `SECRETS_BIN=${bin} reads ${row.installed ?? 'no version'}, below ${pinnedSpec(row.tool)}; point it at a newer build or unset it` });
      continue;
    }
    const result = installCli(pinManifest(row.tool), { logToStderr: opts.logToStderr });
    const installed = await installedCliVersion(pinManifest(row.tool));
    if (result.error || !meetsFloor(installed, row.floor)) {
      out.push({
        ...row,
        installed,
        state: 'failed',
        error: result.error ?? `\`${row.tool} --version\` reads ${installed ?? 'nothing'} after installing ${pinnedSpec(row.tool)}; another install on PATH shadows it`,
      });
      continue;
    }
    out.push({ ...row, installed, state: row.state === 'missing' ? 'installed' : 'upgraded' });
  }
  return out;
}
