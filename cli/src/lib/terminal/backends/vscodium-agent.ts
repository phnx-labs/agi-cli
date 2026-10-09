import * as fs from 'fs';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';

const EXTENSION_AUTHORITY = 'swarmify.swarm-ext';

export interface EditorVariant {
  cli: string;
  scheme: string;
  app: string;
  label: string;
}

export const EDITOR_VARIANTS: EditorVariant[] = [
  { cli: 'codium', scheme: 'vscodium', app: '/Applications/VSCodium.app', label: 'VSCodium' },
  { cli: 'cursor', scheme: 'cursor', app: '/Applications/Cursor.app', label: 'Cursor' },
  { cli: 'code', scheme: 'vscode', app: '/Applications/Visual Studio Code.app', label: 'VS Code' },
];

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function spawnUri(
  scheme: string,
  cwd: string,
  command: string[],
  direction?: SplitDirection,
  meta?: { agent?: string; sessionId?: string; title?: string },
): string {

  const payload: {
    command: string;
    cwd: string;
    split?: SplitDirection;
    agent?: string;
    sessionId?: string;
    title?: string;
  } = {
    command: command.join(' '),
    cwd,
  };
  if (direction) payload.split = direction;
  if (meta?.agent) payload.agent = meta.agent;
  if (meta?.sessionId) payload.sessionId = meta.sessionId;
  if (meta?.title) payload.title = meta.title;
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${scheme}://${EXTENSION_AUTHORITY}/spawn?p=${p}`;
}

export function editorVariantForHost(host: string | undefined): EditorVariant | undefined {
  return host ? EDITOR_VARIANTS.find((v) => v.cli === host) : undefined;
}

export function focusUri(scheme: string, terminalId: string): string {
  return `${scheme}://${EXTENSION_AUTHORITY}/focus?terminalId=${encodeURIComponent(terminalId)}`;
}

// The extension's /focus only searches the window that receives the URL, and
// the editor routes a URL to its frontmost window. Opening the tab's folder
// first brings the owning window forward, so the URL lands there.
export function focusTabSpecs(variant: EditorVariant, folder: string, terminalId: string): LaunchSpec[] {
  const bundled = `${variant.app}/Contents/Resources/app/bin/${variant.cli}`;
  const cli = appExists(bundled) ? bundled : variant.cli;
  return [
    { argv: [cli, folder] },
    { argv: [cli, '--open-url', focusUri(variant.scheme, terminalId)] },
  ];
}

export function makeVscodiumAgentBackend(variant: EditorVariant): TerminalBackend {
  return {
    id: 'vscodium-agent',
    label: `${variant.label} agent`,
    isAvailable(ctx: EngineContext): boolean {
      return ctx.platform === 'darwin' && appExists(variant.app);
    },
    buildTab(cwd: string, command: string[], meta?): LaunchSpec {
      return { argv: [variant.cli, '--open-url', spawnUri(variant.scheme, cwd, command, undefined, meta)] };
    },
    buildSplit(cwd: string, command: string[], direction: SplitDirection, meta?): LaunchSpec {
      return { argv: [variant.cli, '--open-url', spawnUri(variant.scheme, cwd, command, direction, meta)] };
    },
  };
}

export const vscodiumAgentBackend: TerminalBackend = makeVscodiumAgentBackend(EDITOR_VARIANTS[0]);
