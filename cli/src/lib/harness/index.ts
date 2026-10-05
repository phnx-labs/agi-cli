/** Harness adapter barrel: importing it registers every built-in adapter (like
 * lib/channels/providers/index.ts), so consumers import `resolveHarnessAdapter` from here. */
import { registerHarnessAdapter } from './adapter.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { copilotAdapter } from './adapters/copilot.js';
import { kimiAdapter } from './adapters/kimi.js';
import { museAdapter } from './adapters/muse.js';
import { cursorAdapter } from './adapters/cursor.js';
import { grokAdapter } from './adapters/grok.js';
import { opencodeAdapter } from './adapters/opencode.js';
import { droidAdapter } from './adapters/droid.js';

for (const adapter of [
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  kimiAdapter,
  museAdapter,
  cursorAdapter,
  grokAdapter,
  opencodeAdapter,
  droidAdapter,
]) {
  registerHarnessAdapter(adapter);
}

export {
  type HarnessAdapter,
  type ExecConfigEnvCtx,
  type ShimConfigEnvCtx,
  type ExecLaunchArgsCtx,
  type RoutineLaunchCtx,
  CONFIG_DIR_ENV_KEYS,
  stripForeignConfigDir,
  registerHarnessAdapter,
  resolveHarnessAdapter,
  listHarnessAdapters,
} from './adapter.js';
