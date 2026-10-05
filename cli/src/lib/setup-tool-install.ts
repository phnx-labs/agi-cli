import { installCli, resolveCliManifest } from './cli-resources.js';
import { getCachedToolSetup, refreshToolSetup, type SetupTool } from './setup-tool-status.js';
import { pinnedSpec } from './standalone-tools.js';

/** Use the host installer; setup must not install or start a tool from a read. */
export async function installSetupTool(tool: Exclude<SetupTool, 'secrets'>): Promise<boolean> {
  if (getCachedToolSetup().find((row) => row.tool === tool)?.installed) return true;
  const manifest = resolveCliManifest(tool) ?? {
    name: tool,
    check: { kind: 'which' as const, cmd: tool },
    install: [{ npm: pinnedSpec(tool) }],
    source: 'builtin',
    path: '',
  };
  const result = installCli(manifest);
  if (result.error) console.error(result.error);
  const rows = await refreshToolSetup(tool);
  const installed = rows[0]?.installed === true;
  if (!installed && !result.error) console.error(`${tool} installation did not produce a standalone executable on PATH.`);
  return result.installed && installed;
}
