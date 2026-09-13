import os from 'node:os';
import type { SetupTool } from '../lib/setup-tool-status.js';
import { currentContext, openRunInTerminal, parseTerminalFlag, toHostSamples } from '../lib/terminal/index.js';

/** The GUI starts a terminal; the terminal child owns wizard completion. */
export async function openSetupTerminal(tool: SetupTool, terminal: boolean | string, installOnly = false): Promise<void> {
  if (installOnly) throw new Error('--terminal and --install-only are separate setup modes.');
  const parsed = parseTerminalFlag(terminal);
  if (parsed.error) throw new Error(parsed.error);
  const { getActiveSessions } = await import('../lib/session/active.js');
  const result = await openRunInTerminal({
    argv: ['setup', tool],
    forced: parsed.backend,
    cwd: os.homedir(),
    sessions: await toHostSamples(await getActiveSessions()),
    ctx: currentContext(),
  });
  if (!result.ok) throw new Error(result.error ?? 'Could not open a terminal for setup.');
  console.log(result.description ?? 'Setup opened in a terminal.');
}
