import * as vscode from 'vscode';
import { BUILT_IN_AGENTS, getBuiltInByKey, getBuiltInDefByTitle, getBuiltInByPrefix, isAgentRunner, usesManagedAgentLaunch, modeFlagForAgent, AgentLaunchMode, RunStrategy, buildAgentLaunchCommand, wrapNativeAgentCommand, shquote } from '../core/agents';
import { resolveProjectForCwd } from '../core/managedProjects';
import { parseSpawnRequest, resolveSpawnSurface, SpawnRequest } from '../core/spawn';
import {
  buildNewAgentLaunchCommand,
  harnessLaunchRegistrations,
  resolveLaunchTarget,
  type NewAgentLaunchOpts,
} from '../core/launchTarget';
import {
  AgentConfig,
  buildIconPath,
  createAgentConfig,
  getBuiltInByTitle
} from './agents.vscode';
import * as claudemd from './claudemd.vscode';
import { AgentsMarkdownEditorProvider, swarmCurrentDocument } from './customEditor';
import { AgentsHtmlReaderProvider } from './htmlReader';
import * as git from './git.vscode';
import { AgentSettings, hasLoginEnabled, PromptEntry, QUICK_LAUNCH_SLOT_KEYS, getQuickLaunchSlot, QuickLaunchSlot, QuickLaunchSlotKey } from '../core/settings';
import { listRegisteredDevices } from './deviceHealth.vscode';
import { isDerivedSessionName, normalizeHost } from '../core/remoteSessions';
import * as settings from './settings.vscode';
import * as swarm from './swarm.vscode';
import {
  registerWatchdogPaletteCommands,
  migrateAutoRotateSettingOnce,
} from './watchdog.vscode';
import { startWatchdogBridge } from '../mcp/watchdog-bridge';
import { ensureWatchdogMcpInstalled } from '../mcp/watchdogInstall';
import * as notifications from './notifications.vscode';
import * as terminals from './terminals.vscode';
import { fetchRemoteSessionLabelSource, fetchSessionIdentity, fetchRecapSessions, LOCAL_LABEL, LOCAL_MACHINE_ID, mapWithConcurrency } from './remoteSessions.vscode';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import {
  isScaffoldingSessionTopic,
  planSessionTabLabelUpdate,
} from '../core/sessionTabLabelSync';
import { runRecapHeadless, isRecapSupported } from './recap.vscode';
import { buildAgentTerminalEnv } from '../core/terminals';
import {
  buildAgentRunLaunchCommand,
  buildAutoRunLaunchCommand,
  buildResumeInput,
} from '../core/resumeInBest';
import { runStaggered, RESTORE_MAX_CONCURRENCY, RESTORE_STAGGER_MS } from '../core/restoreThrottle';
import * as os from 'os';
import * as fsSync from 'fs';
import { randomUUID } from 'crypto';
import * as workbench from './workbench.vscode';
import { ensureSymlinksOnWorkspaceOpen, createSymlinksCodebaseWide } from './agentlinks.vscode';
import {
  initWorkspaceConfig,
  getActiveWorkspaceFolder,
  loadWorkspaceConfig,
  watchConfigFile,
  watchUserConfig,
} from './swarmifyConfig.vscode';
import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  GEMINI_TITLE,
  CURSOR_TITLE,
  OPENCODE_TITLE,
  findTerminalNameByTabLabel,
  getExpandedAgentName,
  getTerminalDisplayInfo,
  parseTerminalName,
  sanitizeLabel,
  formatTerminalTitle,
  getSessionChunk,
  truncateText,
  extractFirstNWords,
  extractLinearTicketId,
  formatRelativeTime,
  TerminalIdentificationOptions,
  prefixToAgentType,
  SessionAgentType
} from '../core/utils';
import { generateLabelWithLLM } from '../core/labelgen';
import { readClaudeSessionName, readClaudeSessionNameInfo } from '../core/sessionName';
import * as path from 'path';
import { spawn } from 'child_process';
import { DEFAULT_DISPLAY_PREFERENCES } from '../core/settings';
import * as readiness from './terminalReadiness';
import { resolveAlias, isAgentInstalled, checkInstalledAgentsViaCli } from '../core/agentModels';
import { buildForkSessionRequest, type ForkSessionIntent } from '../core/forkSession';
import { handleForkPickHost, registerForkPickHostCommand, remoteForkSessionId, resolveForkSessionId } from './forkCommands.vscode';
import { FORK_LINEAGE_KEY, recordForkEdge, type ForkEdge } from '../core/forkLineage';
import {
  buildSessionBrowserRows,
  cleanSessionTopic,
  formatSessionWhen,
  type BrowsableSession,
  type SessionBrowserSessionRow,
} from '../core/sessionBrowser';
import {
  handleForkPickedSession,
  loadBrowsableSessions,
  registerForkPickSessionCommand,
  runSessionBrowserPicker,
} from './sessionBrowser.vscode';
import type { RemoteSession } from '../core/remoteSessions';
import {
  abandonedCandidates,
  defaultPickedIds,
  distinctiveTopic,
  nextPreselection,
  sharedTopicPrefixes,
  STATE_HEADINGS,
  type ResumeCandidate,
  type ResumeState,
} from '../core/resumePicker';
import { buildHarnessOptions, type HarnessOption } from '../core/resumeTarget';
import { fetchAgentInventories } from '../core/agentInventory';
// readAgentRunStrategy no longer needed: agents-cli reads strategy from
// agents.yaml itself when invoked via `agents run`.
import { resolveAgentsBin, AgentsBinNotFoundError } from '../core/agentsBin';

const AGENTS_CLI_INSTALL_CMD = 'npm install -g @phnx-labs/agents-cli';
/** How many recent transcripts `Agents: Resume` loads. Live sessions are always
 *  included regardless of this cap — a detached one is often days old. */
const RESUME_PICKER_LIMIT = 100;
let agentsCliPromptShown = false;

async function ensureAgentsCliInstalled(): Promise<void> {
  try {
    await resolveAgentsBin();
  } catch (err) {
    if (!(err instanceof AgentsBinNotFoundError) || agentsCliPromptShown) return;
    agentsCliPromptShown = true;
    const choice = await vscode.window.showInformationMessage(
      'Swarmify needs the agents CLI. Install it now?',
      { modal: false },
      'Install',
      'Later',
    );
    if (choice === 'Install') {
      const term = vscode.window.createTerminal({ name: 'Install agents-cli' });
      term.show();
      term.sendText(AGENTS_CLI_INSTALL_CMD);
    }
  }
}
import { supportsPrewarming, buildVersionedResumeCommand, exitSequenceFor } from '../core/prewarm';
import { generateClaudeSessionId, listOpencodeSessions } from '../core/prewarm.simple';
import { liveSessionIdForShell } from '../core/liveSession';
import { canonicalSessionId } from '../core/canonicalSessionId';
import {
  activeMapCacheKey,
  isLocalActiveMapKey,
  needsSessionIdHydrate,
  fetchTerminalIdSessionMap,
} from '../core/sessionIdHydrate';
import {
  hydrateRemoteTabTick,
  planActiveMapHydration,
  type RemoteAutoLabelHooks,
} from '../core/remoteAutoLabel';
import { displayIdentity } from '../core/statusIdentity';
import { getSessionPathBySessionId, getSessionPreviewInfo, getOpenCodeSessionPreviewInfo, getCursorSessionPreviewInfo } from './sessions.vscode';
import * as tasksImport from './tasks.vscode';
import { SOURCE_BADGES } from '../core/tasks';
import * as handoff from '../core/handoff';
import { decodeInjectQuery, selectInjectTarget } from '../core/inject';

// Settings types are now imported from ./settings
// Settings functions are in ./settings.vscode

let agentStatusBarItem: vscode.StatusBarItem | undefined;
let defaultAgentTitle: string = CLAUDE_TITLE;
let secondaryAgentTitle: string = CODEX_TITLE;
let lastFocusedTerminal: vscode.Terminal | null = null;
const statusIdentityInFlight = new Set<string>();

// BUILT_IN_AGENTS is now imported from ./agents

// Prompts helpers (file-based storage at ~/.swarmify/agents/prompts.yaml)
function getPrompts(): PromptEntry[] {
  return settings.readPrompts();
}

function savePrompts(prompts: PromptEntry[]): void {
  settings.writePrompts(prompts);
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getDisplayPrefs(context: vscode.ExtensionContext) {
  return settings.getSettings(context).display || DEFAULT_DISPLAY_PREFERENCES;
}

function buildTerminalTitle(
  prefix: string,
  label: string | undefined | null,
  context: vscode.ExtensionContext,
  sessionId?: string | null,
  isFocused?: boolean
): string {
  const display = getDisplayPrefs(context);
  const sessionChunk = display.showSessionIdInTitles ? getSessionChunk(sessionId || undefined) : null;
  return formatTerminalTitle(prefix, { label: label || undefined, display, sessionChunk, isFocused });
}

// Build the launch command for any built-in agent. Always routes through
// `agents run <agent> --interactive` so the agents-cli applies the
// configured strategy (pinned/available/balanced) from agents.yaml. Claude
// gets --session-id for resume; other agents detect their own session
// post-spawn.
type LaunchableAgent = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'antigravity';

// buildAgentLaunchCommand, RunStrategy, and shquote are now in core/agents.ts
// so they can be unit-tested without a VS Code harness.

// PATH augmented with the agents shim dirs — the extension-host PATH can omit them,
// so a bare `agents` spawn would fail to resolve. Shared by the detached spawns below.
function agentsSpawnEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPath = [
    path.join(home, '.agents/.cache/shims'),
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].join(':');
  return { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ''}` };
}

// Dispatch an agent HEADLESS: `agents run <agent> --mode <m> --headless -p <prompt>`
// spawned DETACHED with no terminal tab. The run outlives this call (`unref`) and
// shows in `agents sessions --active` under this machine as context:'headless', so it
// can be focused/resumed later via `agents sessions focus`. No shell: args go straight
// to the binary (prompt stays a single arg, no quoting hazard).
export function runHeadlessAgent(
  agentKey: string,
  prompt: string,
  mode: AgentLaunchMode,
  cwd?: string,
): void {
  // modeFlagForAgent -> '--mode auto' | '--mode edit' | ... ; split into argv parts.
  const modeArgs = (modeFlagForAgent(agentKey, mode) ?? '').split(' ').filter(Boolean);
  const args = ['run', agentKey, ...modeArgs, '--headless', '-p', prompt];
  const child = spawn('agents', args, {
    cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: agentsSpawnEnv(),
  });
  child.unref();
}

// Focus a session: `agents sessions focus <id>` opens/attaches a real terminal on it (a
// background/headless run reopens in a new tab and resumes; a live terminal session is
// attached). It auto-resolves the surface (no interactive picker), so it's safe to run
// detached from the extension host.
// Send the active agent terminal to the background: `agents sessions detach <id>`
// stops its interactive process and continues it headless, then we close the tab.
// When the active terminal isn't an agent, fall back to a picker over the live agent tabs.
async function detachAgentToBackground(): Promise<void> {
  const active = vscode.window.activeTerminal;
  let sessionId: string | undefined;
  let target: vscode.Terminal | undefined;
  if (active && terminals.isAgentTerminal(active) && terminals.getSessionId(active)) {
    sessionId = terminals.getSessionId(active);
    target = active;
  } else {
    const candidates = vscode.window.terminals.filter(
      (t) => terminals.isAgentTerminal(t) && terminals.getSessionId(t),
    );
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('No live agent terminal to send to the background.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((t) => ({
        label: `${terminals.getAgentType(t) ?? 'agent'} ${(terminals.getSessionId(t) ?? '').slice(0, 8)}`,
        detail: t.name,
        terminal: t,
      })),
      { placeHolder: 'Send which agent to the background?' },
    );
    if (!pick) return;
    sessionId = terminals.getSessionId(pick.terminal);
    target = pick.terminal;
  }
  if (!sessionId) {
    void vscode.window.showWarningMessage('That agent has no resolved session id yet — try again once it has started.');
    return;
  }
  const child = spawn('agents', ['sessions', 'detach', sessionId], {
    detached: true,
    stdio: 'ignore',
    env: agentsSpawnEnv(),
  });
  child.unref();
  target?.dispose();
  void vscode.window.showInformationMessage(
    `Sent ${sessionId.slice(0, 8)} to the background — running headless. Bring it back with “Agents: Attach”.`,
  );
}

// Bring a backgrounded/parked agent to the foreground: pick from the CLI's
// active-session list (presence background/parked) and open a terminal running
// `agents sessions attach <id>`, which resumes the session interactively in that tab.
async function attachAgentFromBackground(): Promise<void> {
  const sessions = sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL)
    .filter((session) => session.host === LOCAL_LABEL);
  const backgrounded = sessions.filter((s) => s.presence === 'background' || s.presence === 'parked');
  if (backgrounded.length === 0) {
    void vscode.window.showInformationMessage('No backgrounded agents to bring forward. Send one back with “Agents: Detach”.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    backgrounded.map((s) => ({
      label: `${s.agentType || 'agent'} ${(s.sessionId || '').slice(0, 8)}`,
      description: s.presence,
      detail: s.topic || s.label,
      sessionId: s.sessionId,
    })),
    { placeHolder: 'Bring which agent to the foreground?' },
  );
  if (!pick?.sessionId) return;
  const term = vscode.window.createTerminal({ name: `attach ${pick.sessionId.slice(0, 8)}`, env: agentsSpawnEnv() });
  term.show();
  term.sendText(`agents sessions attach ${pick.sessionId}`);
}

export function focusSessionInTerminal(sessionId: string): void {
  const child = spawn('agents', ['sessions', 'focus', sessionId], {
    detached: true,
    stdio: 'ignore',
    env: agentsSpawnEnv(),
  });
  child.unref();
}

// Back-compat shim: keeps the old name used elsewhere in this file. The
// strategy argument is no longer needed since agents-cli reads it from
// agents.yaml directly. `buildClaudeOpenCommand` is no longer called —
// pinned now also routes through `agents run`.
function buildClaudeLaunchCommand(
  _context: vscode.ExtensionContext,
  sessionId: string,
  defaultModel?: string,
  additionalFlags?: string,
  mode?: AgentLaunchMode,
): string {
  return buildAgentLaunchCommand('claude', sessionId, defaultModel, additionalFlags, undefined, undefined, mode);
}

// --- Fleet-aware launch: routing belongs to agents-cli -----------------------
const BALANCED_HOST = 'balanced';

async function resolveSlotHost(slot: QuickLaunchSlot): Promise<string | undefined> {
  const target = slot.runOn?.trim();
  if (!target || target === 'local') return undefined;
  if (target === BALANCED_HOST) return 'auto';
  const devices = await listRegisteredDevices();
  const device = devices.find(row => normalizeHost(row.name) === normalizeHost(target));
  if (!device) {
    vscode.window.showWarningMessage(`Launch host "${target}" is not a registered device.`);
    return undefined;
  }
  return device.name;
}

async function pickLaunchHost(
  _context: vscode.ExtensionContext,
  title = 'Run on…',
  _agentKey?: string,
): Promise<{ host?: string; cancelled: boolean }> {
  const devices = await listRegisteredDevices();
  const picked = await vscode.window.showQuickPick([
    { label: '$(vm) This Mac', description: 'Run locally', host: undefined as string | undefined },
    ...devices.map(device => ({
      label: `${device.online ? '$(radio-tower)' : '$(circle-slash)'} ${device.name}`,
      description: device.online ? 'online' : 'offline',
      host: device.name as string | undefined,
    })),
  ], { title, placeHolder: title });
  return picked ? { host: picked.host, cancelled: false } : { cancelled: true };
}

// --- The one launch engine --------------------------------------------------
// Every "New agent" command routes through launchAgent. The command is just a
// route: it fills in whichever of {agentKey, host} the user pinned, and the
// engine resolves the rest. The per-harness default and Pick Host variants ask
// agents-cli to show the chosen device's account/version picker; the explicit
// (Auto) variant uses balanced rotation without a picker.
/**
 * Everything a freshly created agent terminal needs beyond `createTerminal`.
 *
 * This is the half that #2534 dropped from `launchAgent`: registration is what
 * makes a tab visible to Copy Session ID / Resume / Handoff / Fork, and what
 * schedules the persistence that restores it after a window reload. It lives in
 * one place so the two creation paths cannot drift again.
 */
async function registerAgentTerminal(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext,
  args: {
    terminalId: string;
    agentConfig: Omit<AgentConfig, 'count'>;
    agentKey?: string;
    sessionId?: string | null;
    host?: string | null;
    pinnedVersion?: string | null;
  }
): Promise<void> {
  const { terminalId, agentConfig, agentKey, sessionId, host, pinnedVersion } = args;
  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);

  const resumeKey = agentKey ? agentKeyFromSession(agentKey) : null;
  if (resumeKey) {
    terminals.setAgentType(terminal, resumeKey);
  }
  // Stamp the host BEFORE the label poller starts: the poller reads the entry
  // to decide whether to look the session up locally or over `--host`.
  if (host) {
    terminals.setHost(terminal, host);
  }
  if (sessionId) {
    terminals.setSessionId(terminal, sessionId);
    if (resumeKey) {
      startAutoLabelPollerForTerminal(terminal, context);
    }
  } else if (host && resumeKey) {
    // Idless remote runner: only Claude's id is minted up front, so a
    // picked-host Codex launches with none and the local SessionStart watcher
    // never fires for it. The poller resolves the canonical id from the shared
    // per-host active map instead (RUSH-2411).
    startAutoLabelPollerForTerminal(terminal, context, { fast: true });
  }
  if (pinnedVersion) {
    terminals.setVersion(terminal, pinnedVersion);
  }
}

async function launchAgent(context: vscode.ExtensionContext, opts: NewAgentLaunchOpts = {}): Promise<void> {
  let host = opts.host;
  if (opts.pickHost) {
    const picked = await pickLaunchHost(context, 'New agent — run on…', opts.agentKey);
    if (picked.cancelled) return;
    host = picked.host;
  }
  const automatic = !opts.agentKey;
  const cwd = getActiveWorkspaceFolder()?.uri.fsPath;
  const builtIn = opts.agentKey ? getBuiltInByKey(opts.agentKey) : undefined;

  // An automatic launch has no harness yet — the CLI picks it — but the tab must
  // still be a tracked terminal, so it registers against the `shell` def and
  // shell adoption upgrades the entry once the runner announces itself. That is
  // the same fallback spawnCommandTerminal uses. Registering only when the agent
  // is known would leave `agents.newAgent` (the flagship command) unregistered
  // and, worse, silently unreadied: sendCommandWhenReady rejects without a
  // readiness registration and the launch line gets typed into a prompt-less
  // shell.
  const def = builtIn ?? getBuiltInByKey('shell');
  if (!def) return;
  const agentConfig = createAgentConfig(
    context.extensionPath, def.title, def.command, def.icon, def.prefix,
  );

  const defaultModel = builtIn
    ? settings.getDefaultModel(context, builtIn.key as Parameters<typeof settings.getDefaultModel>[1])
    : undefined;
  // `--project` owns the working directory end-to-end, so it and cwd are
  // mutually exclusive (buildAgentLaunchCommand throws if both are passed).
  const projectSlug = cwd ? await resolveProjectForCwd(cwd) : undefined;
  // "Local" must cover BOTH an explicit `local: true` (the per-harness New X
  // commands) and a Pick Host prompt the user answered with "This Mac", which
  // returns no host. Passing plain `opts.local` there leaves it undefined, the
  // builder's `local = false` default fires `--device auto`, and a deliberate
  // This-Mac pick silently dispatches to another box.
  //
  // Everything else means "choose a machine for me", which is what
  // `--device auto` is for, so it must NOT be treated as local. Device choice
  // stays with the CLI rather than being scored here, per the thin-client contract.
  const isLocal = opts.local === true || (opts.pickHost === true && !host);
  const command = buildNewAgentLaunchCommand(
    { ...opts, host, local: isLocal },
    { defaultModel, projectSlug, cwd },
  );

  // Tab identity must be established AT createTerminal: iconPath and name are
  // frozen there (no setter), and AGENT_TERMINAL_ID is the join key the CLI's
  // `sessions --active` rows carry back — without it the status bar can never
  // resolve a session id. Shell adoption cannot repair any of it later; it only
  // rewrites the internal registry, never the live terminal.
  const terminalId = terminals.nextId(agentConfig.prefix);
  // Registering an automatic launch under the `shell` def is a REGISTRY choice
  // (adoption re-keys it later); it does not make the tab a user shell. Only a
  // real `New Shell` is one. Conflating the two would declare
  // `scrubSensitive: false` / `kind: 'shell'` on a tab that is about to run an
  // agent, which is the opposite of the policy in core/terminals.ts.
  const isUserShell = opts.agentKey === 'shell';
  const terminal = vscode.window.createTerminal({
    name: automatic ? 'Agents Auto' : buildTerminalTitle(agentConfig.title, undefined, context, null),
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    env: buildAgentTerminalEnv(terminalId, undefined, cwd, undefined, {
      scrubSensitive: !isUserShell,
      kind: isUserShell ? 'shell' : 'agent',
    }),
    isTransient: true,
  });
  terminal.show(false);
  await registerAgentTerminal(terminal, context, {
    terminalId,
    agentConfig,
    agentKey: opts.agentKey,
    host,
  });
  // The harness is unknown until the runner starts, so let adoption re-key the
  // entry to the real agent the CLI picked.
  if (automatic) armShellAdoptionForTerminal(terminal, context);
  await sendCommandWhenReady(terminal, command);
  if (opts.agentKey) {
    readiness.armAgentReady(terminal, {});
  }
}

// Terminal readiness detection moved to src/vscode/terminalReadiness.ts.
// All spawn/resume flows now call readiness.waitFor(t, 'promptReady') instead.

/**
 * Detect OpenCode session ID after spawn by comparing session lists.
 * OpenCode creates its own session IDs (ses_xxx format) internally.
 * This runs asynchronously and updates the terminal entry when found.
 */
async function detectOpencodeSessionId(
  terminal: vscode.Terminal,
  terminalId: string,
  cwd: string,
  sessionsBefore: string[],
  context: vscode.ExtensionContext
): Promise<void> {
  // Wait for OpenCode to start and create a session
  await new Promise(resolve => setTimeout(resolve, 3000));

  const sessionsAfter = await listOpencodeSessions(cwd);
  if (!sessionsAfter || sessionsAfter.length === 0) {
    console.log(`[PREWARM] OpenCode: No sessions found after spawn`);
    return;
  }

  // Find new session (in sessionsAfter but not in sessionsBefore)
  const beforeSet = new Set(sessionsBefore);
  const newSessions = sessionsAfter.filter(id => !beforeSet.has(id));

  let sessionId: string | null = null;
  if (newSessions.length === 1) {
    sessionId = newSessions[0];
  } else if (newSessions.length > 1) {
    // Multiple new sessions - take the first one (most recent based on list order)
    sessionId = newSessions[0];
  } else {
    // No new sessions - take the most recent from after list
    sessionId = sessionsAfter[0];
  }

  if (sessionId) {
    console.log(`[PREWARM] OpenCode detected session ID: ${sessionId}`);
    terminals.setSessionId(terminal, sessionId);
    terminals.setAgentType(terminal, 'opencode');
    // Update terminal title to include session ID
    updateStatusBarForTerminal(terminal, context.extensionPath);
    startAutoLabelPollerForTerminal(terminal, context);
  }
}

async function updateTerminalTitleOnFocus(
  newTerminal: vscode.Terminal | undefined,
  context: vscode.ExtensionContext
): Promise<void> {
  const display = getDisplayPrefs(context);

  // Only update titles if showLabelOnlyOnFocus is enabled
  if (!display.showLabelOnlyOnFocus) {
    return;
  }

  // Update the newly focused terminal's title (with label)
  if (newTerminal) {
    const entry = terminals.getByTerminal(newTerminal);
    if (entry?.agentConfig) {
      const newTitle = buildTerminalTitle(
        entry.agentConfig.prefix,
        entry.label,
        context,
        entry.sessionId,
        true  // isFocused = true
      );
      await terminals.renameTerminal(newTerminal, newTitle);
    }
  }

  // Update the previously focused terminal's title (without label)
  if (lastFocusedTerminal && lastFocusedTerminal !== newTerminal) {
    const prevEntry = terminals.getByTerminal(lastFocusedTerminal);
    if (prevEntry?.agentConfig) {
      const prevTitle = buildTerminalTitle(
        prevEntry.agentConfig.prefix,
        prevEntry.label,
        context,
        prevEntry.sessionId,
        false  // isFocused = false
      );
      await terminals.renameTerminal(lastFocusedTerminal, prevTitle);
    }
  }

  // Update tracking
  lastFocusedTerminal = newTerminal || null;
}

interface PromptQuickPickItem extends vscode.QuickPickItem {
  entry?: PromptEntry;
  isAddNew?: boolean;
}

async function showPrompts(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }

  const parsed = parseTerminalName(terminal.name);
  if (!parsed.isAgent) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const prompts = getPrompts();

  // Sort: favorites first, then by accessedAt descending (most recently used first)
  const sorted = [...prompts].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return b.accessedAt - a.accessedAt;
  });

  const quickPick = vscode.window.createQuickPick<PromptQuickPickItem>();
  quickPick.placeholder = 'Search prompts...';
  quickPick.matchOnDescription = true;

  const buildItems = (): PromptQuickPickItem[] => {
    const items: PromptQuickPickItem[] = sorted.map(entry => ({
      label: `${entry.isFavorite ? '$(star-full) ' : ''}${entry.title}`,
      description: truncateText(entry.content, 50),
      detail: entry.content,
      entry,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon(entry.isFavorite ? 'star-full' : 'star-empty'),
          tooltip: entry.isFavorite ? 'Remove from favorites' : 'Add to favorites'
        },
        {
          iconPath: new vscode.ThemeIcon('trash'),
          tooltip: 'Delete prompt'
        }
      ]
    }));

    items.push({
      label: '$(add) Add new prompt',
      isAddNew: true
    });

    return items;
  };

  quickPick.items = buildItems();

  quickPick.onDidTriggerItemButton(async (e) => {
    const item = e.item;
    if (!item.entry) return;

    const buttonIndex = (quickPick.items.find(i => i.entry?.id === item.entry?.id) as PromptQuickPickItem)
      ?.buttons?.indexOf(e.button);

    if (buttonIndex === 0) {
      // Toggle favorite
      item.entry.isFavorite = !item.entry.isFavorite;
      item.entry.updatedAt = Date.now();
      savePrompts(prompts);
      // Re-sort and rebuild items
      sorted.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
        return b.accessedAt - a.accessedAt;
      });
      quickPick.items = buildItems();
    } else if (buttonIndex === 1) {
      // Delete
      const idx = prompts.findIndex(p => p.id === item.entry?.id);
      if (idx !== -1) {
        prompts.splice(idx, 1);
        const sortedIdx = sorted.findIndex(p => p.id === item.entry?.id);
        if (sortedIdx !== -1) sorted.splice(sortedIdx, 1);
        savePrompts(prompts);
        quickPick.items = buildItems();
      }
    }
  });

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected) return;

    quickPick.hide();

    if (selected.isAddNew) {
      // Add new prompt flow
      const title = await vscode.window.showInputBox({
        prompt: 'Prompt title',
        placeHolder: 'e.g., Debug Helper'
      });
      if (!title) return;

      const content = await vscode.window.showInputBox({
        prompt: 'Prompt content',
        placeHolder: 'Enter the prompt text...'
      });
      if (!content) return;

      const now = Date.now();
      const newEntry: PromptEntry = {
        id: generateId(),
        title,
        content,
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
        accessedAt: now
      };

      prompts.push(newEntry);
      savePrompts(prompts);
      vscode.window.showInformationMessage(`Added "${title}" to Prompts`);
    } else if (selected.entry) {
      // Update accessedAt and paste to terminal (no auto-execute)
      selected.entry.accessedAt = Date.now();
      savePrompts(prompts);
      terminal.sendText(selected.entry.content, false);
      terminal.show();
    }
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

function getAgentsToOpen(context: vscode.ExtensionContext): AgentConfig[] {
  const agentSettings = settings.getSettings(context);
  const extensionPath = context.extensionPath;
  const agents: AgentConfig[] = [];

  // Built-in agents
  for (const def of BUILT_IN_AGENTS) {
    const config = agentSettings.builtIn[def.key as keyof AgentSettings['builtIn']];
    if (config.login && config.instances > 0) {
      agents.push({ ...createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix), count: config.instances });
    }
  }

  // Custom agents
  for (const custom of agentSettings.custom) {
    if (custom.login && custom.instances > 0) {
      agents.push({
        ...createAgentConfig(extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase()),
        count: custom.instances
      });
    }
  }

  return agents;
}

// getBuiltInByTitle is now imported from ./agents.vscode

interface AgentTerminalInfo {
  isAgent: boolean;
  prefix: string | null;
  label: string | null;
  iconPath: vscode.IconPath | null;
}

/**
 * Extract identification options from a VS Code terminal.
 */
function extractTerminalIdentificationOptions(terminal: vscode.Terminal): TerminalIdentificationOptions {
  const opts = terminal.creationOptions as vscode.TerminalOptions;
  const env = opts?.env;
  const terminalId = env ? env['AGENT_TERMINAL_ID'] : undefined;

  // Extract icon filename from iconPath
  let iconFilename: string | null = null;
  if (opts?.iconPath) {
    const icon: any = opts.iconPath;
    if (icon instanceof vscode.Uri) {
      iconFilename = path.basename(icon.fsPath);
    } else if (icon && typeof icon === 'object') {
      // Handle { light: Uri; dark: Uri } shape
      const candidate = icon.light ?? icon.dark ?? icon;
      if (candidate instanceof vscode.Uri || (candidate && typeof candidate.fsPath === 'string')) {
        iconFilename = path.basename(candidate.fsPath);
      }
    }
  }

  return {
    name: terminal.name,
    terminalId: terminalId as string | undefined,
    iconFilename
  };
}

function identifyAgentTerminal(terminal: vscode.Terminal, extensionPath: string): AgentTerminalInfo {
  // First check terminals module state
  const entry = terminals.getByTerminal(terminal);
  if (entry && entry.agentConfig) {
    return {
      isAgent: true,
      prefix: entry.agentConfig.title,
      label: entry.label ?? null,
      iconPath: buildIconPath(entry.agentConfig.title, extensionPath)
    };
  }

  // Fall back to central identification function with all available inputs
  const identOpts = extractTerminalIdentificationOptions(terminal);
  const info = getTerminalDisplayInfo(identOpts);
  if (info.isAgent && info.prefix) {
    return {
      isAgent: true,
      prefix: info.prefix,
      label: info.label,
      iconPath: buildIconPath(info.prefix, extensionPath)
    };
  }

  return { isAgent: false, prefix: null, label: null, iconPath: null };
}

function getAgentConfigFromTerminal(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext
): Omit<AgentConfig, 'count'> | null {
  const info = identifyAgentTerminal(terminal, context.extensionPath);

  if (!info.isAgent || !info.prefix) {
    // Check custom agents by name
    const terminalName = terminal.name.trim();
    const agentSettings = settings.getSettings(context);
    for (const custom of agentSettings.custom) {
      if (terminalName === custom.name || terminalName.startsWith(`${custom.name} - `)) {
        return createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());
      }
    }
    return null;
  }

  // Check built-in agents
  const builtIn = getBuiltInDefByTitle(info.prefix);
  if (builtIn) {
    return createAgentConfig(context.extensionPath, builtIn.title, builtIn.command, builtIn.icon, builtIn.prefix);
  }

  // Check custom agents
  const agentSettings = settings.getSettings(context);
  for (const custom of agentSettings.custom) {
    if (info.prefix === custom.name) {
      return createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());
    }
  }

  return null;
}

// Settings functions are now in ./settings.vscode

// scanExistingEditorTerminals is now terminals.scanExisting()

// Infer agent config from terminal name for scan
function inferAgentConfigFromName(name: string, extensionPath: string, knownPrefix?: string | null): Omit<AgentConfig, 'count'> | null {
  // Build identification options - when called from scanExisting, we may have a knownPrefix
  const identOpts: TerminalIdentificationOptions = { name };
  // If we have a knownPrefix from the env var extraction, we can reconstruct a terminalId pattern
  // to trigger the terminalId fallback strategy
  if (knownPrefix) {
    identOpts.terminalId = `${knownPrefix}-0`; // Fake ID just to trigger the strategy
  }

  const info = getTerminalDisplayInfo(identOpts);
  if (!info.isAgent || !info.prefix) return null;

  const def = getBuiltInDefByTitle(info.prefix);
  if (def) {
    return createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix);
  }
  return null;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Agents extension is now active');

  // Store context for deactivate
  extensionContext = context;

  // Revive any AGI EXT dashboard tab VS Code restored from the previous
  // session. Must be registered before any await so the restored webview
  // doesn't sit blank while activation runs.
  settings.registerPanelSerializer(context);

  // Prompt to install agents-cli if missing. Don't block activation —
  // resolveAgentsBin runs in the background; if it throws AgentsBinNotFoundError
  // we surface a notification with a one-click installer.
  void ensureAgentsCliInstalled();

  // Initialize terminal readiness event tracking (shell integration + close cleanup)
  readiness.initReadiness(context);

  // Cross-window live-terminal registry: every VS Code window publishes its
  // agent terminals to a shared JSON file so the Foreman (and future tools)
  // can see the factory state across all windows. Keepalive every 15s; also
  // fires on open/close.
  initForemanRegistry(context);

  // Elect exactly one "monitor" owner across all open IDE windows (epic #64,
  // foundation #65). The winner will own the heavy global probes/watches in
  // later migration issues; for now it just holds a renewable lease so the rest
  // of the stack can gate on isLeader(). Re-elects automatically on takeover.
  initMonitorLeader(context);

  // Monitor runtime (#67): the leader runs the broadcast host; EVERY window runs
  // a thin follower that reports its terminal tuples to the monitor and resolves
  // broadcast facts back to its own terminals. Migrations #68-71 move the heavy
  // probes/watchers/panel behind this gate; they are NOT moved here.
  initMonitorHost(context);
  initMonitorFollower(context);

  // Activity-bar sidebar that always reflects the currently focused agent
  // terminal: title, version, label, cwd, PLAN.md, and any teams running in
  // this directory. Lazy-resolves when the user clicks the activity-bar icon.
  const { registerAgentPanel } = require('./agentPanel.vscode') as typeof import('./agentPanel.vscode');
  registerAgentPanel(context);

  // Issues view: GitHub + Linear issues scoped to the current repository.
  const { registerIssuesPanel } = require('./issuesPanel.vscode') as typeof import('./issuesPanel.vscode');
  registerIssuesPanel(context);

  // Create status bar item for showing active terminal status bar label
  agentStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  agentStatusBarItem.text = 'Agents';
  agentStatusBarItem.command = 'agents.sessionId';
  agentStatusBarItem.tooltip = 'Copy session ID';
  agentStatusBarItem.show();
  context.subscriptions.push(agentStatusBarItem);

  // Scan existing terminals in the editor area to register any agent terminals
  // Then restore persisted sessions with proper icons/titles
  terminals.scanExisting(
    (name, knownPrefix) => inferAgentConfigFromName(name, context.extensionPath, knownPrefix),
    context,
    (terminal) => startAutoLabelPollerForTerminal(terminal, context)
  )
    .then(() => restoreAgentTerminals(context))
    .then(() => {
      // Adopt any SH terminals that are already running an agent CLI
      // (e.g. user launched claude before reload).
      for (const entry of terminals.getAllTerminals()) {
        if (entry.agentConfig?.prefix === 'sh') {
          armShellAdoptionForTerminal(entry.terminal, context);
        }
      }
    })
    .catch(err => {
      console.error('[EXTENSION] Error scanning/restoring terminals:', err);
    });

  // Register terminals that appear after activation (e.g., restored sessions)
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(async (terminal) => {
      // Already tracked?
      if (terminals.getByTerminal(terminal)) {
        return;
      }

      // Use central identification with all available inputs
      const identOpts = extractTerminalIdentificationOptions(terminal);
      const info = getTerminalDisplayInfo(identOpts);
      if (!info.isAgent || !info.prefix) {
        return;
      }

      const agentConfig = inferAgentConfigFromName(terminal.name, context.extensionPath, info.prefix);
      if (!agentConfig) {
        return;
      }

      const id = identOpts.terminalId || terminals.nextId(info.prefix);
      let pid: number | undefined;
      try {
        pid = await terminal.processId;
      } catch {
        // ignore
      }

      terminals.register(terminal, id, agentConfig, pid, context, info.label || undefined);
      readiness.registerTerminal(terminal, { restored: true });

      const agentType = prefixToAgentType(info.prefix);
      if (agentType) {
        // Register the agent type even when sessionId is missing so
        // sessionTracker can adopt a fresh session file later.
        terminals.setAgentType(terminal, agentType);
      }

      if (identOpts.sessionId) {
        terminals.setSessionId(terminal, identOpts.sessionId);
        if (agentType) {
          startAutoLabelPollerForTerminal(terminal, context);
        }
      }

      if (info.prefix === 'SH') {
        armShellAdoptionForTerminal(terminal, context);
      }
    })
  );

  // Start watchdog MCP bridge for smart agent mode
  const watchdogBridge = startWatchdogBridge(context);
  context.subscriptions.push(watchdogBridge);

  // Register the watchdog MCP server in each supported agent's user-scope
  // config so peer terminals can call `send_to_agent`. Fire-and-forget —
  // failures are logged but never block activation.
  ensureWatchdogMcpInstalled(watchdogBridge.mcpServerPath).catch((err) => {
    console.warn('[WATCHDOG] ensureWatchdogMcpInstalled failed:', err);
  });

  // The extension holds NO watchdog loop: the CLI daemon watchdog
  // (`agents watchdog enable`, under `agents __daemon-run`) is the sole
  // watchdog — stall nudging AND rotate-on-exhaustion, injecting into vscodium
  // tabs via the `/inject` URI verb over live-terminals.json and writing the
  // shared watchdog.log the Fleet status card reads. What remains here
  // is the palette on/off and the one-time settings migration.
  context.subscriptions.push(...registerWatchdogPaletteCommands(vscode.commands.registerCommand));

  // Migrate an explicit `agents.watchdog.autoRotate: false` (a deleted setting)
  // to the CLI watchdog's off state — once per user.
  void migrateAutoRotateSettingOnce(context.globalState);

  // Ensure CLAUDE.md has Swarm instructions if Swarm is enabled
  claudemd.ensureSwarmInstructions();

  // Ensure symlinks exist for workspaces with .agents config
  for (const folder of vscode.workspace.workspaceFolders || []) {
    ensureSymlinksOnWorkspaceOpen(folder).catch(err => {
      console.error('[agents] Error ensuring symlinks:', err);
    });
  }

  // Watch for .agents config changes
  watchConfigFile(context, (workspaceFolder) => {
    ensureSymlinksOnWorkspaceOpen(workspaceFolder).catch(err => {
      console.error('[agents] Error ensuring symlinks on config change:', err);
    });
  });

  // Watch for user-level .agents config changes
  watchUserConfig(context, () => {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      ensureSymlinksOnWorkspaceOpen(folder).catch(err => {
        console.error('[agents] Error ensuring symlinks on user config change:', err);
      });
    }
  });

  // Register URI handler for notification callbacks
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query);

        if (uri.path === '/focus') {
          const terminalId = params.get('terminalId');
          const entry = terminalId ? terminals.getById(terminalId) : undefined;
          if (entry) {
            entry.terminal.show();
          }
        } else if (uri.path === '/inject') {
          // External nudge: an outside process (agents-cli) delivers text into a
          // live integrated terminal by session id. Payload is base64url-JSON in
          // the single `p` query param. Malformed input logs + returns, never throws.
          const payload = decodeInjectQuery(uri.query);
          if (!payload) {
            console.warn('[INJECT] Ignoring malformed inject URI (bad or missing `p` payload)');
            return;
          }

          const all = terminals.getAllTerminals();
          const target = selectInjectTarget(all, payload.terminalId);
          if (!target) {
            const known = all.map((t) => t.sessionId).filter(Boolean).join(', ');
            console.warn(
              `[INJECT] No live terminal for id ${payload.terminalId}. Active sessions: ${known}`
            );
            return;
          }

          try {
            if (payload.enter === false) {
              // Text only, no submit.
              target.terminal.sendText(payload.text, false);
            } else if (payload.combined) {
              // Single write with the carriage return appended.
              target.terminal.sendText(payload.text + '\r', false);
            } else {
              // Ink-safe default: two writes so Claude's TUI sees Enter alone.
              target.terminal.sendText(payload.text, false);
              target.terminal.sendText('\r', false);
            }
            console.log(
              `[INJECT] Delivered to ${target.id} (session ${target.sessionId ?? 'unknown'}): "${payload.text.slice(0, 80)}${payload.text.length > 80 ? '…' : ''}"`
            );
          } catch (err) {
            console.error(
              `[INJECT] Failed to deliver to ${target.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // /spawn — open an agent terminal in an editor tab running the supplied
        // command (e.g. `claude --resume <id>`). Used by the agents-cli terminal
        // engine's `vscodium-agent` backend to resume sessions into this editor.
        if (uri.path === '/spawn') {
          const req = parseSpawnRequest(uri.query);
          if (req) {
            await spawnCommandTerminal(context, req);
          }
        }
      }
    })
  );

  // Register custom markdown + HTML readers
  try {
    context.subscriptions.push(
      AgentsMarkdownEditorProvider.register(context)
    );
  } catch (error) {
    // Editor already registered (hot reload) - continue activation
    console.log('Custom markdown editor already registered, continuing...');
  }
  try {
    context.subscriptions.push(AgentsHtmlReaderProvider.register(context));
  } catch (error) {
    console.log('Custom HTML reader already registered, continuing...');
  }

  try {
    const currentSettings = settings.getSettings(context);
    await workbench.setMarkdownEditorAssociation(
      currentSettings.editor?.markdownViewerEnabled ?? true
    );
  } catch (error) {
    console.error('Failed to apply markdown editor association:', error);
  }

  // Load cached default agents if set
  const storedDefault = context.globalState.get<string>('agents.defaultAgentTitle');
  if (storedDefault) {
    defaultAgentTitle = storedDefault;
  }
  const storedSecondary = context.globalState.get<string>('agents.secondaryAgentTitle');
  if (storedSecondary) {
    secondaryAgentTitle = storedSecondary;
  } else {
    secondaryAgentTitle = CODEX_TITLE;
    context.globalState.update('agents.secondaryAgentTitle', CODEX_TITLE);
  }

  // Set initial context keys and subscribe to config changes
  await updateContextKeys(context);
  updateActiveAgentContextKey(vscode.window.activeTerminal, context.extensionPath);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('agents')) {
        await updateContextKeys(context);
      }
    })
  );

  // Run lightweight first-setup if needed
  await maybeRunFirstSetup(context);

  // Open Dashboard on startup if enabled (welcome screen)
  const agentSettings = settings.getSettings(context);
  if (agentSettings.showWelcomeScreen) {
    // Delay slightly to allow VS Code to fully initialize
    setTimeout(() => {
      settings.openPanel(context);
    }, 500);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.open', () => openAgentTerminals(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.openAgent', () => goToTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.cycleNextTerminal', () => cycleAgentTerminal(1))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.cyclePrevTerminal', () => cycleAgentTerminal(-1))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.reopenLastSession', () => reopenLastClosedSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.detach', () => detachAgentToBackground())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.attach', () => attachAgentFromBackground())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.configure', () => settings.openPanel(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.dispatchTask', () => settings.openPanelAndDispatch(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.focusQuickSpawn', () => settings.openPanelAndFocusQuickSpawn(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.settings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:agents');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgent', () => launchAgent(context, {}))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newSecondaryAgent', async () => {
      const targetTitle = secondaryAgentTitle || defaultAgentTitle;
      const targetDef = getBuiltInDefByTitle(targetTitle);
      let agentConfig: Omit<AgentConfig, 'count'> | null = getBuiltInByTitle(context.extensionPath, targetTitle);
      if (targetDef?.key && !(await isAgentInstalled(targetDef.key))) {
        agentConfig = null;
      }
      if (!agentConfig) {
        agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      }
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentHSplit', async () => {
      // Create horizontal split (new editor group below current)
      await vscode.commands.executeCommand('workbench.action.splitEditorDown');

      // Open default agent in the new (active) group
      const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentVSplit', async () => {
      // Create vertical split (new editor group to the side)
      await vscode.commands.executeCommand('workbench.action.splitEditor');

      // Open default agent in the new (active) group
      const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setTitle', () => setStatusBarLabelForActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.relabelTerminal', () => relabelActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.clear', () => clearActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.reload', () => reloadActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.autogit', git.generateCommitMessage)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.prompts', showPrompts)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setupClaude', () => swarm.setupSwarmIntegrationForAgent('claude', context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setupCodex', () => swarm.setupSwarmIntegrationForAgent('codex', context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.enableNotifications', () => notifications.enableNotifications(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.enableReader', async () => {
      const current = settings.getSettings(context);
      const next: AgentSettings = {
        ...current,
        editor: { ...(current.editor ?? { markdownViewerEnabled: true }), markdownViewerEnabled: true }
      };
      await settings.saveSettings(context, next);
      vscode.window.showInformationMessage(
        'Agents Reader enabled. .md opens in the Notion-style editor; .html opens as a rendered preview.'
      );
      await updateContextKeys(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.disableReader', async () => {
      const current = settings.getSettings(context);
      const next: AgentSettings = {
        ...current,
        editor: { ...(current.editor ?? { markdownViewerEnabled: true }), markdownViewerEnabled: false }
      };
      await settings.saveSettings(context, next);
      vscode.window.showInformationMessage(
        'Agents Reader disabled. .md and .html open in the default text editor.'
      );
      await updateContextKeys(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newTask', () => newTaskWithContext(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.askAnotherAgent', () => askAnotherAgentFromTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.spawnWithPrompt', async (args?: { agent?: string; prompt?: string }) => {
      await spawnWithPrompt(context, args);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.spawnWithContext', async () => {
      await spawnWithContext(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.forkCurrentSession', () => forkCurrentSession(context))
  );

  context.subscriptions.push(registerForkPickHostCommand(
    vscode.commands.registerCommand,
    () => forkCurrentSession(context, { pickHost: true }),
  ));

  context.subscriptions.push(
    registerForkPickSessionCommand(vscode.commands.registerCommand, () => forkPickedSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.forkRecap', () => forkCurrentSession(context, { intent: 'recap' }))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.handoff', () => handoffToAgent(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.closeWithRecap', () => closeActiveAgentWithRecap(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.continueInNew', () => continueInNewSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.continueFromSelection', () => continueFromSelection(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionTrace', () => copySessionTrace(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionId', () => copySessionId())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionResume', () => resumeSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resume', () => resumeSessionsBatch(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resumePickSession', () =>
      resumeSessionsBatch(context, {
        title: 'Agents: Resume (Pick Session)',
        abandonedOnly: true,
      })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resumePickHost', () => resumeCurrentPickHost(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resumePickHarness', () => resumeCurrentPickHarness(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agents.resumeCurrentInBestProfile',
      () => resumeCurrentInBestProfile(context)
    )
  );

  interface TerminalQuickPickItem extends vscode.QuickPickItem {
    terminal: vscode.Terminal;
  }

  // Agents: Init - create .agents config and symlinks
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.init', async () => {
      const workspaceFolder = getActiveWorkspaceFolder();
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
      }

      // Create/open .agents config
      const config = await initWorkspaceConfig(workspaceFolder);
      if (!config) {
        return;
      }

      // Create symlinks codebase-wide
      const { created, errors } = await createSymlinksCodebaseWide(workspaceFolder, config);

      if (errors.length > 0) {
        vscode.window.showWarningMessage(`Created ${created} symlink(s), but ${errors.length} failed.`);
        console.error('[agents] Symlink errors:', errors);
      } else if (created > 0) {
        vscode.window.showInformationMessage(`Created ${created} symlink(s) in workspace.`);
      } else {
        vscode.window.showInformationMessage('.agents config ready. No new symlinks needed.');
      }
    })
  );

  /** The configured default target for the bare `New <Harness>` commands. */
  const defaultLaunchTarget = () =>
    resolveLaunchTarget(vscode.workspace.getConfiguration('agents').get<string>('launch.defaultTarget'));

  // Per-harness launch commands — every one is a thin route into launchAgent.
  // For each non-shell agent:
  //   New <Harness>              -> configured device target, then account/version picker
  //   New <Harness> (Pick Host)  -> device picker, then account/version picker
  //   New <Harness> (Auto)       -> automatic device + balanced account/version
  for (const def of BUILT_IN_AGENTS) {
    if (def.key === 'shell') {
      // Shell is a plain terminal — no balancing, no host offload.
      context.subscriptions.push(
        vscode.commands.registerCommand(def.commandId, () => {
          const agentConfig = getBuiltInByTitle(context.extensionPath, def.title);
          if (agentConfig) openSingleAgent(context, agentConfig);
        })
      );
      continue;
    }
    if (def.key === 'gemini') {
      // Gemini is deprecated; Antigravity is the replacement. Don't register
      // launch commands for it, but keep session parsing/watching intact.
      continue;
    }
    // Where a bare `New <Harness>` runs is read at press time, so a settings
    // change applies without reloading the window. Registration and final
    // command construction are pure/tested in core/launchTarget.ts.
    for (const registration of harnessLaunchRegistrations(def.key, def.commandId, defaultLaunchTarget)) {
      context.subscriptions.push(
        vscode.commands.registerCommand(registration.commandId, () =>
          launchAgent(context, registration.launchOptions())),
      );
    }
  }

  // Generic device-first launch: pick the HOST, then the harness is auto-picked
  // from what's available + has headroom on that host, with balanced rotation.
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentPickHost', () => launchAgent(context, { pickHost: true }))
  );

  // Dynamically register custom agent commands
  const customAgentSettings = settings.getSettings(context);
  for (const custom of customAgentSettings.custom) {
    const commandId = `agents.new${custom.name.replace(/[^a-zA-Z0-9]/g, '')}`;
    const agentConfig = createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());

    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, () => {
        openSingleAgent(context, agentConfig);
      })
    );

    console.log(`Registered custom agent command: ${commandId} for ${custom.name}`);
  }

  // Register the "New (Alias)" command - shows a QuickPick of all configured aliases
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAlias', async () => {
      const currentSettings = settings.getSettings(context);
      const aliases = currentSettings.aliases || [];

      if (aliases.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No aliases configured. Create one in the Agents dashboard.',
          'Open Dashboard'
        );
        if (action === 'Open Dashboard') {
          vscode.commands.executeCommand('agents.configure');
        }
        return;
      }

      // Build QuickPick items
      const items = aliases.map(alias => {
        const builtInDef = getBuiltInByKey(alias.agent);
        const agentName = builtInDef ? getExpandedAgentName(builtInDef.prefix) : alias.agent;
        return {
          label: `${agentName} (${alias.name})`,
          description: alias.flags,
          alias
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an alias to launch'
      });

      if (selected) {
        const builtInDef = getBuiltInByKey(selected.alias.agent);
        if (builtInDef) {
          const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);
          if (agentConfig) {
            openSingleAgent(context, agentConfig, selected.alias.flags);
          }
        }
      }
    })
  );

  // Dynamically register command aliases
  // Aliases let users define shortcuts like "Agents: New Claude (Fast)" with custom flags
  const aliases = customAgentSettings.aliases || [];
  for (const alias of aliases) {
    // Get the built-in agent this alias is for
    const builtInDef = getBuiltInByKey(alias.agent);
    if (!builtInDef) {
      console.warn(`Alias "${alias.name}" references unknown agent: ${alias.agent}`);
      continue;
    }

    // Create command ID: agents.alias.Fast, agents.alias.MaxContext, etc.
    const commandId = `agents.alias.${alias.name.replace(/[^a-zA-Z0-9]/g, '')}`;
    const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);

    if (agentConfig) {
      context.subscriptions.push(
        vscode.commands.registerCommand(commandId, () => {
          openSingleAgent(context, agentConfig, alias.flags);
        })
      );

      console.log(`Registered alias command: ${commandId} -> ${alias.agent} with flags: ${alias.flags}`);
    }
  }

  // Register quick launch commands (Cmd+Shift+0..9). Always register all ten so
  // keybindings stay valid even before the user assigns a slot — unassigned
  // shortcuts silently no-op.
  // Launch a configured slot. `forceHostPick` (⌘⌥⇧n) overrides the slot's baked
  // Run-on target with an interactive host pick for this one launch.
  const launchQuickSlot = async (digit: QuickLaunchSlotKey, forceHostPick: boolean) => {
    // Re-read settings on every press so newly saved slots take effect
    // without reloading the window.
    const fresh = settings.getSettings(context);
    const slot: QuickLaunchSlot | undefined = getQuickLaunchSlot(fresh.quickLaunch, digit);
    if (!slot) return;

    const builtInDef = getBuiltInByKey(slot.agent);
    if (!builtInDef) return;

    const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);
    if (!agentConfig) return;

    let modelId = slot.model;
    if (!modelId && slot.modelAlias) {
      modelId = (await resolveAlias(slot.agent, slot.modelAlias)) ?? undefined;
    }

    const parts: string[] = [];
    if (modelId) parts.push(`--model ${modelId}`);
    if (slot.mode) parts.push(`--mode ${slot.mode}`);
    if (slot.extraFlags && slot.extraFlags.trim()) parts.push(slot.extraFlags.trim());
    const flags = parts.length ? parts.join(' ') : undefined;

    let host: string | undefined;
    if (forceHostPick) {
      const picked = await pickLaunchHost(context, `Run ${slot.label || builtInDef.title} on…`);
      if (picked.cancelled) return;
      host = picked.host;
    } else {
      host = await resolveSlotHost(slot);
    }

    openSingleAgent(context, agentConfig, flags, slot.version || undefined, undefined, host);
  };

  for (const digit of QUICK_LAUNCH_SLOT_KEYS) {
    // ⌘⇧n — fire the slot on its baked Run-on target.
    context.subscriptions.push(
      vscode.commands.registerCommand(`agents.quickLaunch${digit}`, () => launchQuickSlot(digit, false)),
    );
    // ⌘⌥⇧n — fire the slot but pick the host this once.
    context.subscriptions.push(
      vscode.commands.registerCommand(`agents.quickLaunch${digit}PickHost`, () => launchQuickSlot(digit, true)),
    );
  }

  // Single terminal-close handler: normal teardown when the agent exits.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      void (async () => {
        const entry = terminals.getByTerminal(terminal);

        // Capture session info before unregistering (for reopen).
        // Capture session info before unregistering (for reopen).
        if (entry?.agentConfig && entry.sessionId) {
          terminals.pushClosedSession({
            terminalId: entry.id,
            prefix: entry.agentConfig.prefix,
            sessionId: entry.sessionId,
            host: entry.host,
            label: entry.label,
            agentType: entry.agentType,
            version: entry.version,
            account: entry.account || entry.statusAccount || undefined,
            agentConfig: entry.agentConfig,
            closedAt: Date.now()
          });
        }

        terminals.unregister(terminal);
        updateActiveAgentContextKey(vscode.window.activeTerminal, context.extensionPath);
      })();
    })
  );

  // Update status bar when active terminal changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      updateActiveAgentContextKey(terminal, context.extensionPath);
      if (!agentStatusBarItem) return;

      if (!terminal) {
        agentStatusBarItem.text = 'Agents';
        return;
      }

      // Check if this is an agent terminal and scroll to bottom
      const agentInfo = identifyAgentTerminal(terminal, context.extensionPath);
      if (agentInfo.isAgent) {
        vscode.commands.executeCommand('workbench.action.terminal.scrollToBottom');

        // Try to fetch label on focus if not already set (immediate update instead of 5-min poller)
        tryFetchLabelOnFocus(terminal, context);
      }

      updateStatusBarForTerminal(terminal, context.extensionPath);

      // Update terminal titles based on focus state (for showLabelOnlyOnFocus feature)
      updateTerminalTitleOnFocus(terminal, context);
    })
  );

  // Prefer activeTerminal (identity) over a tab-label name match: same-agent
  // terminals share a name ("CC"), so name matching always returns the first.
  const terminalForActiveTab = (tabLabel: string | undefined): vscode.Terminal | undefined => {
    const active = vscode.window.activeTerminal;
    if (active) return active;
    if (!tabLabel) return undefined;
    const names = vscode.window.terminals.map((t) => t.name);
    const matchedName = findTerminalNameByTabLabel(names, tabLabel);
    return matchedName ? vscode.window.terminals.find((t) => t.name === matchedName) : undefined;
  };

  // Update status bar when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!agentStatusBarItem) return;

      if (editor) {
        // Switching to a real text editor - reset status bar
        agentStatusBarItem.text = 'Agents';
      } else {
        // editor is undefined - could be switching to a terminal tab
        // Check if active tab is a terminal and update status bar accordingly
        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        const activeTab = activeGroup?.activeTab;

        if (activeTab?.input instanceof vscode.TabInputTerminal) {
          const matchedTerminal = terminalForActiveTab(activeTab.label);
          if (matchedTerminal) {
            updateStatusBarForTerminal(matchedTerminal, context.extensionPath);
            return;
          }
        }
      }
    })
  );

  // Listen for tab changes to catch editor-area terminal switches
  // (onDidChangeActiveTerminal doesn't fire reliably for terminal editor tabs)
  // Debounced because onDidChangeTabs fires in rapid bursts during workspace restore,
  // tab drag, etc. — each fire used to trigger a full session-file read.
  let tabChangeTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!agentStatusBarItem) return;
      if (tabChangeTimer) clearTimeout(tabChangeTimer);
      tabChangeTimer = setTimeout(() => {
        tabChangeTimer = undefined;
        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        const activeTab = activeGroup?.activeTab;

        if (!activeTab || !(activeTab.input instanceof vscode.TabInputTerminal)) {
          return;
        }

        const matchedTerminal = terminalForActiveTab(activeTab.label);
        if (!matchedTerminal) return;

        tryFetchLabelOnFocus(matchedTerminal, context);
        updateStatusBarForTerminal(matchedTerminal, context.extensionPath);
        updateTerminalTitleOnFocus(matchedTerminal, context);
      }, 120);
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (tabChangeTimer) clearTimeout(tabChangeTimer);
    },
  });

  // Auto-open terminals on startup if any agents have login enabled
  const startupSettings = settings.getSettings(context);
  if (hasLoginEnabled(startupSettings)) {
    setTimeout(() => openAgentTerminals(context), 1000);
  }
}

async function sendCommandWhenReady(
  terminal: vscode.Terminal,
  command: string,
): Promise<void> {
  const t0 = Date.now();
  const elapsed = () => `t+${Date.now() - t0}ms`;
  console.log(`[SEND-CMD] ${elapsed()} waiting for promptReady`);
  try {
    await readiness.waitFor(terminal, 'promptReady');
    console.log(`[SEND-CMD] ${elapsed()} promptReady fired, sending`);
  } catch (err) {
    console.warn(`[SEND-CMD] ${elapsed()} promptReady wait failed: ${err}. Sending anyway.`);
  }
  terminal.sendText(command);
  console.log(`[SEND-CMD] ${elapsed()} sendText returned`);
}

async function openSingleAgent(
  context: vscode.ExtensionContext,
  agentConfig: Omit<AgentConfig, 'count'>,
  additionalFlags?: string,
  pinnedVersion?: string,
  strategy?: RunStrategy,
  host?: string
) {
  // A host target ('local'/undefined = this machine) always routes through
  // `agents run <agent> --host <device>` so the CLI does the SSH offload —
  // including agents that launch as raw binaries locally.
  const targetHost = host && host !== 'local' ? host : undefined;

  // Build command with default model if configured
  const builtInDef = getBuiltInDefByTitle(agentConfig.title);
  const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;
  const defaultModel = agentKey && (!additionalFlags || !additionalFlags.includes('--model'))
    ? settings.getDefaultModel(context, agentKey)
    : undefined;
  let command = agentConfig.command || '';
  if (command) {
    if (defaultModel) {
      command = `${command} --model ${defaultModel}`;
    }
    if (additionalFlags) {
      command = `${command} ${additionalFlags}`;
    }
  }

  // Handle session ID for supported agent types
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  const terminalId = terminals.nextId(agentConfig.prefix);
  const cwd = workspaceFolder;

  // If the workspace folder is a bound directory of a defined project, let the
  // CLI resolve `--project <slug>` to a cwd itself (locally or on `host`)
  // instead of Factory computing/forwarding one by hand.
  const projectSlug = await resolveProjectForCwd(workspaceFolder);

  let sessionId: string | null = null;

  // Track OpenCode sessions before spawn to detect new one
  let opencodeSessionsBefore: string[] | null = null;
  if (agentKey === 'opencode') {
    opencodeSessionsBefore = await listOpencodeSessions(cwd);
  }

  // All built-in agents launch via `agents run <agent> --interactive` so the
  // agents-cli picks up the configured strategy (pinned/available/balanced)
  // from ~/.agents/agents.yaml automatically — or an explicit override
  // (pinnedVersion / strategy) from the per-strategy launch commands. Only
  // Claude's session is generated up-front for the resume flow; other agents
  // detect their session post-spawn.
  // EVERY agent runner routes through `agents run` — local, auto-host, and
  // picked-host launches alike — so `--strategy balanced --mode auto` applies
  // uniformly (grok/kimi/droid included; they used to launch as raw binaries with
  // no rotation). Shell is the only non-runner and keeps its raw command. This is
  // the launch contract in apps/ext/AGENTS.md; there is no per-harness list.
  if (agentKey && isAgentRunner(agentKey)) {
    // Mint Claude's session id up front for LOCAL and REMOTE alike. The id is
    // what every downstream surface keys off: the status bar, the auto-label
    // poller that fills in the tab title, and Session Resume / Trace / Fork.
    // A host run used to skip it and let the remote coin its own id, which left
    // remote tabs stuck on the bare agent prefix with an empty status bar and no
    // way to resume them by id. `agents run --host` accepts a caller-supplied
    // `--session-id` and pins the remote session to it (hosts/run-target.ts
    // resolveHostSessionId), so the id we generate here is the id the remote
    // session actually uses.
    if (agentKey === 'claude') {
      sessionId = generateClaudeSessionId();
      console.log(`[SESSION] Claude using on-demand session ID: ${sessionId}${targetHost ? ` (host ${targetHost})` : ''}`);
    }
    // No remote host → this machine. Pass `local: true` so buildAgentLaunchCommand
    // does NOT emit `--device auto` (that flag is only for the explicit Auto path
    // which resolves a host first, or for openSingleAgentWithQueue callers that
    // set local: false). New Grok/Kimi/… must stay local with balanced strategy.
    command = buildAgentLaunchCommand(
      agentKey,
      sessionId,
      defaultModel,
      additionalFlags,
      pinnedVersion,
      strategy,
      undefined,
      {
        host: targetHost,
        local: !targetHost,
        cwd: projectSlug ? undefined : (targetHost ? cwd : undefined),
        project: projectSlug,
      },
    );
  }

  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const title = buildTerminalTitle(agentConfig.title, undefined, context, sessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: editorLocation,
    name: title,
    env: buildAgentTerminalEnv(terminalId, sessionId, cwd, undefined, { scrubSensitive: agentKey !== 'shell', kind: agentKey === 'shell' ? 'shell' : 'agent' }),
    isTransient: true
  });

  // Track + poll any known harness, not just the prewarm five (#1747).
  await registerAgentTerminal(terminal, context, {
    terminalId,
    agentConfig,
    agentKey,
    sessionId,
    host: targetHost,
    pinnedVersion,
  });

  if (command) {
    // wrapNativeAgentCommand exits the shell (closing the tab) on a clean exit
    // but leaves it open with a readable status line on a launch failure
    // (RUSH-2593). No-op for shell tabs.
    await sendCommandWhenReady(terminal, wrapNativeAgentCommand(command, agentKey === 'shell'));
    readiness.armAgentReady(terminal, agentKey && sessionId
      ? { agentKey, sessionId, cwd }
      : {});
  }

  if (agentKey === 'shell') {
    armShellAdoptionForTerminal(terminal, context);
  }

  // OpenCode: Detect session ID asynchronously after spawn
  if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
    detectOpencodeSessionId(terminal, terminalId, cwd, opencodeSessionsBefore, context);
  }
}

// Tracks the most recent /spawn terminal so a follow-up split lands beside it
// (the engine's two-per-tab packing: tab, then split, then tab, …).
let lastSpawnedTerminal: vscode.Terminal | undefined;

// The parent terminal for a split: the last /spawn terminal if it is still
// open, else the active terminal, else none (caller falls back to a new tab).
function aliveSpawnParent(): vscode.Terminal | undefined {
  if (lastSpawnedTerminal && vscode.window.terminals.includes(lastSpawnedTerminal)) {
    return lastSpawnedTerminal;
  }
  return vscode.window.activeTerminal ?? undefined;
}

// Open an editor-tab terminal running an arbitrary command (the /spawn verb).
//
// Prefer an explicit agent from the spawn payload (sessions focus/resume over
// vscodium-agent), then fall back to sniffing the command line for a local
// resume like `claude --resume <id>` / `agents run grok …`. Only when neither
// yields a harness do we open as SH + shell-adoption — that path cannot set the
// icon later (VS Code tab icons are immutable) and cannot promote remote
// attaches whose local tree is just `ssh … tmux attach` (#2478).
//
// When req.split is set, the terminal splits beside the previous /spawn pane
// instead of opening a new tab.
async function spawnCommandTerminal(
  context: vscode.ExtensionContext,
  req: SpawnRequest
): Promise<void> {
  const detectedKey =
    (req.agent && getBuiltInByKey(req.agent) ? req.agent : null) ||
    readiness.detectAgentKeyFromArgs(req.command) ||
    null;
  const def = (detectedKey && getBuiltInByKey(detectedKey)) || getBuiltInByKey('shell');
  if (!def) return;

  const agentConfig = createAgentConfig(
    context.extensionPath,
    def.title,
    def.command,
    def.icon,
    def.prefix
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const cwd = req.cwd || workspaceFolder;
  const terminalId = terminals.nextId(agentConfig.prefix);
  const sessionId =
    req.sessionId || readiness.extractSessionIdFromArgs(req.command) || null;
  const title =
    req.title?.trim() ||
    buildTerminalTitle(agentConfig.title, undefined, context, sessionId);

  const parent = req.split ? aliveSpawnParent() : undefined;
  const surface = resolveSpawnSurface({
    wantsSplit: !!req.split,
    hasParent: !!parent,
  });

  const isShell = def.key === 'shell';
  const env = buildAgentTerminalEnv(terminalId, sessionId, cwd, undefined, {
    scrubSensitive: !isShell,
    kind: isShell ? 'shell' : 'agent',
  });

  const location: vscode.TerminalEditorLocationOptions | vscode.TerminalSplitLocationOptions =
    surface === 'native-split' && parent
      ? { parentTerminal: parent }
      : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false };

  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location,
    name: title,
    env,
    cwd,
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);

  if (!isShell && detectedKey) {
    const resumeKey = agentKeyFromSession(detectedKey);
    if (resumeKey) {
      terminals.setAgentType(terminal, resumeKey);
      if (sessionId) {
        terminals.setSessionId(terminal, sessionId);
        startAutoLabelPollerForTerminal(terminal, context);
      }
    }
  } else {
    armShellAdoptionForTerminal(terminal, context);
  }

  await sendCommandWhenReady(terminal, req.command);
  if (vscode.window.activeTerminal === terminal) {
    updateStatusBarForTerminal(terminal, context.extensionPath);
  }
  terminal.show();
  lastSpawnedTerminal = terminal;
}

async function newTaskWithContext(context: vscode.ExtensionContext) {
  const agentSettings = settings.getSettings(context);
  const { tasks } = await tasksImport.fetchAllTasks(context, agentSettings.taskSources);

  let message: string;

  if (tasks.length === 0) {
    const userPrompt = await vscode.window.showInputBox({
      prompt: 'Enter task for the agent',
      placeHolder: 'What should the agent do?'
    });

    if (userPrompt === undefined) return;

    message = userPrompt;
  } else {
    interface TaskQuickPickItem extends vscode.QuickPickItem {
      task: typeof tasks[0];
    }

    const items: TaskQuickPickItem[] = tasks.map(task => {
      const badge = SOURCE_BADGES[task.source];
      const identifier = task.metadata.identifier;
      const description = identifier ? `${badge.label} ${identifier}` : badge.label;

      return {
        label: task.title,
        description,
        detail: task.description ? `${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}` : undefined,
        task
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a task to work on',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!selected) return;

    const task = selected.task;
    message = task.title;

    if (task.description) {
      message += `\n\n${task.description}`;
    }

    if (task.metadata.url) {
      message += `\n\nReference: ${task.metadata.url}`;
    }
  }

  const clipboardText = await vscode.env.clipboard.readText();
  if (clipboardText && clipboardText.trim()) {
    message = `<context>\n${clipboardText.trim()}\n</context>\n\n${message}`;
  }

  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (agentConfig) {
    await openSingleAgentWithQueue(context, agentConfig, [message]);
  }
}

async function askAnotherAgentFromTerminal(context: vscode.ExtensionContext) {
  const clipboardText = (await vscode.env.clipboard.readText()).trim();
  if (!clipboardText) {
    vscode.window.showInformationMessage(
      'Copy the line first (Cmd+C), then press Cmd+Shift+K or right-click and choose "Start Task".'
    );
    return;
  }

  const preview = clipboardText.length > 80
    ? `${clipboardText.slice(0, 80).replace(/\s+/g, ' ')}...`
    : clipboardText.replace(/\s+/g, ' ');

  const question = await vscode.window.showInputBox({
    prompt: `Start a task with context: ${preview}`,
    placeHolder: 'What should the agent do?'
  });
  if (question === undefined || !question.trim()) return;

  const sourceTerminal = vscode.window.activeTerminal;
  const sourceEntry = sourceTerminal ? terminals.getByTerminal(sourceTerminal) : undefined;
  const sourceAgent = sourceEntry?.agentConfig
    ? getExpandedAgentName(sourceEntry.agentConfig.prefix)
    : undefined;
  const sourceSessionId = sourceEntry?.sessionId;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  let sourceSummary: string | null = null;
  if (sourceSessionId) {
    sourceSummary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Loading source session summary…' },
      () => handoff.getSessionSummaryViaAgentsCli(sourceSessionId, workspacePath)
    );
  }

  const contextLines: string[] = [];
  if (sourceAgent) contextLines.push(`source-agent: ${sourceAgent}`);
  if (sourceSessionId) contextLines.push(`source-session-id: ${sourceSessionId}`);
  if (workspacePath) contextLines.push(`workspace: ${workspacePath}`);
  contextLines.push('selected-text:');
  contextLines.push(clipboardText);
  if (sourceSummary) {
    contextLines.push('');
    contextLines.push('source-session-summary:');
    contextLines.push(sourceSummary);
  }

  const message = `<context>\n${contextLines.join('\n')}\n</context>\n\n${question.trim()}`;
  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (agentConfig) {
    await openSingleAgentWithQueue(context, agentConfig, [message]);
  }
}

async function handoffToAgent(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal to handoff from');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const fromAgent = getExpandedAgentName(terminalEntry.agentConfig.prefix);
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  let messages: handoff.HandoffMessage[] = [];
  let planInfo: { path: string; content: string } | null = null;

  if (terminalEntry.sessionId && terminalEntry.agentType) {
    const agentType = terminalEntry.agentType as 'claude' | 'codex' | 'gemini';

    messages = await handoff.getSessionMessagesViaAgentsCli(terminalEntry.sessionId, 10, workspacePath);

    if (agentType === 'claude') {
      planInfo = await handoff.findRecentClaudePlan();
    }
  }

  if (messages.length === 0 && !planInfo && terminalEntry.agentType !== 'opencode') {
    vscode.window.showInformationMessage('No session history available for handoff');
    return;
  }

  interface AgentQuickPickItem extends vscode.QuickPickItem {
    agentKey: string;
    agentConfig: Omit<AgentConfig, 'count'>;
  }

  const agentItems: AgentQuickPickItem[] = [];

  for (const def of BUILT_IN_AGENTS) {
    if (def.key === 'shell') continue;
    if (def.title === terminalEntry.agentConfig.title) continue;

    const config = getBuiltInByTitle(context.extensionPath, def.title);
    if (!config) continue;

    const expandedName = getExpandedAgentName(def.prefix);
    agentItems.push({
      label: expandedName,
      description: def.key.toUpperCase(),
      agentKey: def.key,
      agentConfig: config
    });
  }

  const customAgentSettings = settings.getSettings(context);
  for (const custom of customAgentSettings.custom) {
    if (custom.name === terminalEntry.agentConfig.title) continue;

    agentItems.push({
      label: custom.name,
      description: 'Custom',
      agentKey: custom.name.toLowerCase(),
      agentConfig: createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase())
    });
  }

  if (agentItems.length === 0) {
    vscode.window.showInformationMessage('No other agents available for handoff');
    return;
  }

  const selectedAgent = await vscode.window.showQuickPick(agentItems, {
    placeHolder: `Handoff from ${fromAgent} to...`,
    matchOnDescription: true
  });

  if (!selectedAgent) return;

  const handoffContext: handoff.HandoffContext = {
    fromAgent,
    messages,
    planContent: planInfo?.content,
    planPath: planInfo?.path
  };

  const prompt = handoff.formatHandoffPrompt(handoffContext);

  await openSingleAgentWithQueue(context, selectedAgent.agentConfig, [prompt]);
}

async function continueInNewSession(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal to continue from');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!terminalEntry.sessionId || !terminalEntry.agentType) {
    vscode.window.showInformationMessage('No session data available to continue from');
    return;
  }

  const [messages, toolStats] = await Promise.all([
    handoff.getSessionMessagesViaAgentsCli(terminalEntry.sessionId, 999, workspacePath),
    handoff.getSessionToolStatsViaAgentsCli(terminalEntry.sessionId, workspacePath)
  ]);

  const originalTask = messages.find(m => m.role === 'user')?.content ?? null;
  const lastResponse = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? null;

  if (!originalTask && !lastResponse) {
    vscode.window.showInformationMessage('No session history available to continue from');
    return;
  }

  const continueCtx: handoff.ContinueContext = {
    originalTask,
    lastResponse,
    recentFiles: toolStats.recentFiles,
    toolCalls: toolStats.toolCalls,
    filesEdited: toolStats.filesEdited,
    filesRead: toolStats.filesRead
  };

  const prompt = handoff.formatContinuePrompt(continueCtx);

  await openSingleAgentWithQueue(context, terminalEntry.agentConfig, [prompt]);
}

async function readSelectionForContinue(): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    return editor.document.getText(editor.selection).trim();
  }
  // No public API exposes terminal selection text — the only path is to copy
  // it to the system clipboard, read, and restore. The two readText calls
  // bracketing copySelection can race on macOS in practice (clipboard write
  // is normally awaited but is not strictly ordered with the next read), so
  // treat any non-empty change as the selection and otherwise restore.
  if (vscode.window.activeTerminal) {
    const original = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const fromTerminal = (await vscode.env.clipboard.readText()).trim();
    if (fromTerminal && fromTerminal !== original.trim()) {
      // Restore the user's prior clipboard — they didn't ask to lose it.
      await vscode.env.clipboard.writeText(original);
      return fromTerminal;
    }
    await vscode.env.clipboard.writeText(original);
  }
  return (await vscode.env.clipboard.readText()).trim();
}

async function continueFromSelection(context: vscode.ExtensionContext) {
  const selection = await readSelectionForContinue();
  if (!selection) {
    vscode.window.showInformationMessage(
      'Select a session ID (in editor or terminal) or copy it first, then press Cmd+Shift+C.'
    );
    return;
  }

  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (!agentConfig) {
    vscode.window.showErrorMessage(`No agent config for default "${defaultAgentTitle}"`);
    return;
  }

  vscode.window.setStatusBarMessage(`Continuing session ${selection.slice(0, 8)}…`, 3000);
  await openSingleAgentWithQueue(context, agentConfig, [`/continue ${selection}`]);
}

interface CliSessionItem {
  id: string;
  shortId: string;
  agent: 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw' | 'cursor';
  timestamp: string;
  version?: string;
  account?: string;
  project?: string;
  cwd?: string;
  filePath?: string;
  topic?: string;
  messageCount?: number;
  tokenCount?: number;
}

/**
 * The recent-transcript listing. `sessions` takes the query as a positional
 * argument and has no `list` subcommand — passing one made commander treat the
 * word "list" as a search term, which matched nothing and left every picker in
 * the extension reporting "No sessions found".
 */
async function listSessionsViaCli(limit = 30): Promise<CliSessionItem[]> {
  const { runAgents } = await import('../core/agentsBin');
  const { stdout } = await runAgents(`sessions --all --json --no-interactive --limit ${limit}`, {
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed as CliSessionItem[];
}

/**
 * The live counterpart of {@link listSessionsViaCli}: which sessions have a
 * process running right now, and — via `viewingIn` — whether anyone is looking
 * at it. Bare (no `--local`) so a session stranded on another fleet box shows up
 * too; those resume over SSH.
 */
// formatSessionWhen and cleanSessionTopic moved to ../core/sessionBrowser (pure,
// unit-tested) and are imported at the top of this file; the fork picker and the
// resume picker both call the shared implementations.

interface SessionPickerOptions {
  title: string;
  placeholder: string;
  pinShortId?: string | null;
  pinLabel?: string;
}

async function pickSession(opts: SessionPickerOptions): Promise<CliSessionItem | null> {
  let sessions: CliSessionItem[];
  try {
    sessions = await listSessionsViaCli(30);
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      vscode.window.showInformationMessage('agents CLI not found. Install with: npm i -g @swarmify/agents-cli');
    } else {
      vscode.window.showInformationMessage(`Failed to list sessions: ${msg.slice(0, 120)}`);
    }
    return null;
  }

  if (sessions.length === 0) {
    vscode.window.showInformationMessage('No sessions found');
    return null;
  }

  if (opts.pinShortId) {
    const idx = sessions.findIndex(s => s.shortId === opts.pinShortId || s.id === opts.pinShortId);
    if (idx > 0) {
      const [pinned] = sessions.splice(idx, 1);
      sessions.unshift(pinned);
    }
  }

  interface SessionQuickPickItem extends vscode.QuickPickItem {
    session: CliSessionItem;
  }

  const items: SessionQuickPickItem[] = sessions.map((s, idx) => {
    const agentLabel = s.version ? `${s.agent}@${s.version}` : s.agent;
    const when = formatSessionWhen(s.timestamp);
    const topic = cleanSessionTopic(s.topic);
    const isPinned = idx === 0 && opts.pinShortId &&
      (s.shortId === opts.pinShortId || s.id === opts.pinShortId);
    const pinTag = isPinned && opts.pinLabel ? `$(pinned) ${opts.pinLabel} · ` : '';
    return {
      label: `${pinTag}${s.shortId}  ${topic}`,
      description: `${agentLabel} · ${when}${s.account ? ` · ${s.account}` : ''}`,
      detail: `${s.project || '-'}${s.cwd ? `  ${s.cwd}` : ''}`,
      session: s,
    };
  });

  const picked = await vscode.window.showQuickPick<SessionQuickPickItem>(items, {
    title: opts.title,
    placeHolder: opts.placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.session ?? null;
}

async function copySessionTrace(_context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  const terminalEntry = activeTerminal ? terminals.getByTerminal(activeTerminal) : null;
  const currentSessionId = terminalEntry?.sessionId ?? null;
  const currentShortId = currentSessionId ? currentSessionId.slice(0, 8) : null;

  const session = await pickSession({
    title: 'Agents: Session Trace',
    placeholder: 'Pick a session to copy its trace to clipboard',
    pinShortId: currentShortId,
    pinLabel: 'Current',
  });
  if (!session) return;

  const { runAgents } = await import('../core/agentsBin');
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  try {
    const { stdout } = await runAgents(`sessions view ${session.id} --trace`, {
      maxBuffer: 10 * 1024 * 1024,
      cwd: workspacePath,
    });

    const lines = stdout.split('\n');
    const headerEnd = lines.findIndex(l => l.startsWith('# '));
    const trace = headerEnd >= 0 ? lines.slice(headerEnd).join('\n') : stdout;

    const agentLabel = session.version ? `${session.agent}@${session.version}` : session.agent;
    const header = [
      `## Session`,
      `- Agent: ${agentLabel}`,
      `- Session ID: ${session.id}`,
      session.cwd ? `- Directory: ${session.cwd}` : '',
      session.account ? `- Account: ${session.account}` : '',
    ].filter(Boolean).join('\n');

    const fullTrace = `${header}\n\n${trace}`;
    await vscode.env.clipboard.writeText(fullTrace);
    vscode.window.setStatusBarMessage(`Session trace copied (${session.shortId})`, 3000);
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    vscode.window.showInformationMessage(`Failed to get session trace: ${msg.slice(0, 120)}`);
  }
}

async function copySessionId() {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  // Prefer a freshly hydrated CLI id (terminalId join / local state) over a
  // spawn-time stamp. Offloaded tabs use the batched --active map; local tabs
  // can also read the SessionStart state file.
  await tryHydrateLiveSessionId(activeTerminal, terminalEntry.agentConfig.prefix || '');
  const refreshed = terminals.getByTerminal(activeTerminal);
  const sessionId = canonicalSessionId(refreshed?.sessionId || terminalEntry.sessionId);

  if (!sessionId) {
    vscode.window.showInformationMessage('No session ID available');
    return;
  }

  await vscode.env.clipboard.writeText(sessionId);
  vscode.window.setStatusBarMessage(`Session ID copied: ${sessionId.slice(0, 8)}...`, 3000);
}

/**
 * The agent key a session resumes under, for the PICKER paths (`Agents: Resume`
 * and `Agents: Session Resume`). Every harness AGI EXT presents can be resumed
 * here — the five prewarm agents through their native flag, the rest through
 * `agents run --resume` (see buildVersionedResumeCommand) — so the gate is
 * membership in the agent registry, not the prewarm subset. `shell` is excluded:
 * a shell tab has no conversation to resume.
 *
 * The OTHER resume surfaces — `restoreAgentTerminals` (reload), the reopen-last
 * command, and reload-active-terminal — now gate on this same registry check
 * rather than `supportsPrewarming`, so grok/kimi/droid/antigravity come back
 * through those too (#1747); reload falls back to a generic exit sequence for
 * agents without a PREWARM_CONFIGS entry.
 */
function agentKeyFromSession(agent: string): SessionAgentType | null {
  if (!agent || agent === 'shell') return null;
  return BUILT_IN_AGENTS.some(a => a.key === agent) ? (agent as SessionAgentType) : null;
}

/** One resumed session, opened as its own editor tab wearing that agent's icon. */
async function openResumedSessionTerminal(
  context: vscode.ExtensionContext,
  session: { id: string; shortId: string; agent: string; version?: string; account?: string; cwd?: string; host?: string },
): Promise<boolean> {
  const agentKey = agentKeyFromSession(session.agent);
  if (!agentKey) {
    vscode.window.showInformationMessage(`Cannot resume sessions of type ${session.agent || 'unknown'}`);
    return false;
  }

  const builtIn = BUILT_IN_AGENTS.find(a => a.key === agentKey);
  if (!builtIn) {
    vscode.window.showInformationMessage(`No built-in agent config for ${agentKey}`);
    return false;
  }

  const agentConfig = createAgentConfig(
    context.extensionPath,
    builtIn.title,
    builtIn.command,
    builtIn.icon,
    builtIn.prefix,
  );

  // A resumed session belongs in ITS OWN directory, not whatever workspace this
  // window happens to have open — batch resume routinely spans several repos.
  const workspacePath = session.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const resumeCmd = buildVersionedResumeCommand(agentKey, session.id, session.version, session.host);

  const terminalId = terminals.nextId(builtIn.prefix);
  const title = buildTerminalTitle(agentConfig.title, undefined, context, session.id);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    cwd: session.cwd,
    env: buildAgentTerminalEnv(terminalId, session.id, workspacePath, session.version),
    isTransient: true,
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);
  terminals.setSessionId(terminal, session.id);
  terminals.setAgentType(terminal, agentKey);
  if (session.version) {
    terminals.setVersion(terminal, session.version);
  }
  if (session.account) {
    terminals.setAccount(terminal, session.account);
  }
  // Stamp the device so everything that later reads this session (label poller,
  // rotate, resume) follows it to the machine the transcript actually lives on.
  if (session.host) {
    terminals.setHost(terminal, session.host);
  }
  startAutoLabelPollerForTerminal(terminal, context);

  try {
    await readiness.waitFor(terminal, 'promptReady');
  } catch (err) {
    console.warn(`[READINESS] promptReady wait failed: ${err}`);
  }
  if (terminal.shellIntegration) {
    terminal.shellIntegration.executeCommand(resumeCmd);
  } else {
    terminal.sendText(resumeCmd);
  }
  readiness.armAgentReady(terminal, {
    agentKey,
    sessionId: session.id,
    cwd: workspacePath,
  });

  terminal.show();
  try {
    await readiness.waitFor(terminal, 'agentReady');
    return true;
  } catch (err) {
    console.warn(`[READINESS] resumed session did not become ready: ${err}`);
    vscode.window.showInformationMessage(`Session ${session.shortId} did not become ready; its terminal remains open with the CLI result.`);
    return false;
  }
}

async function resumeSession(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  const terminalEntry = activeTerminal ? terminals.getByTerminal(activeTerminal) : null;
  const currentSessionId = terminalEntry?.sessionId ?? null;
  const currentShortId = currentSessionId ? currentSessionId.slice(0, 8) : null;

  const session = await pickSession({
    title: 'Agents: Session Resume',
    placeholder: 'Pick a session to resume in a new terminal',
    pinShortId: currentShortId,
    pinLabel: 'Current',
  });
  if (!session) return;

  const opened = await openResumedSessionTerminal(context, session);
  if (opened) {
    vscode.window.setStatusBarMessage(
      `Resuming ${session.agent}${session.version ? `@${session.version}` : ''} · ${session.shortId}`,
      3000,
    );
  }
}

interface ResumeCandidateItem extends vscode.QuickPickItem {
  candidate?: ResumeCandidate;
}

function resumeCandidateItems(candidates: ResumeCandidate[], checked: ReadonlySet<string>): ResumeCandidateItem[] {
  const items: ResumeCandidateItem[] = [];
  // Computed over the whole set, so "shared" means shared by the rows the user
  // is actually looking at rather than by a fixed list of known phrases.
  const prefixes = sharedTopicPrefixes(candidates.map((c) => c.topic ?? '').filter(Boolean));
  let group: ResumeState | undefined;
  for (const c of candidates) {
    if (c.state !== group) {
      group = c.state;
      items.push({ label: STATE_HEADINGS[c.state], kind: vscode.QuickPickItemKind.Separator });
    }
    const agentLabel = c.version ? `${c.agent}@${c.version}` : c.agent;
    const viewing = c.viewingIn ? ` · ${c.viewingIn}` : '';
    const marker = c.state === 'detached' ? '$(debug-disconnect) ' : '';
    // Device leads the row: it is present on every session and, across a
    // multi-machine fleet, it is the field that most often decides whether a
    // row is the one you want. The topic follows with shared boilerplate
    // removed, so what remains is what differs between rows.
    items.push({
      label: `${marker}[${c.host || 'local'}] ${c.shortId}  ${distinctiveTopic(c, prefixes) || '—'}`,
      description: `${agentLabel} · ${formatSessionWhen(new Date(c.lastActivityMs).toISOString())}${viewing}`,
      detail: c.cwd ?? '',
      picked: checked.has(c.id),
      candidate: c,
    });
  }
  return items;
}

async function fetchResumeCandidates(): Promise<ResumeCandidate[]> {
  // The CLI owns lifecycle classification, cross-device aggregation, ranking,
  // and deduplication. Opening (or manually refreshing) the picker performs one
  // bounded read; the extension only adapts those rows for QuickPick.
  const rows = await listSessionsViaCli(RESUME_PICKER_LIMIT) as Array<CliSessionItem & Partial<ResumeCandidate>>;
  return rows.map((row) => ({
    id: row.id,
    shortId: row.shortId || row.id.slice(0, 8),
    agent: row.agent || '',
    version: row.version,
    account: row.account,
    project: row.project,
    cwd: row.cwd,
    topic: row.topic,
    state: row.state || 'idle',
    viewingIn: row.viewingIn || '',
    host: row.host || '',
    lastActivityMs: row.lastActivityMs || Date.parse(row.timestamp || '') || 0,
    pid: row.pid || 0,
  }));
}

/**
 * `Agents: Resume` — pick any number of sessions, each reopens as its own tab.
 *
 * The list leads with sessions that are still RUNNING with nobody attached.
 * Those are pre-ticked, because they are the ones a user opens this command to
 * rescue; everything else is available but unchecked.
 *
 * Stale-while-revalidate: the picker renders the persisted snapshot instantly
 * (the live fleet read takes seconds over SSH) and swaps items in place when
 * the background refresh lands, carrying the user's checks across the swap.
 *
 * `abandonedOnly` is the `Agents: Resume (Pick Session)` variant: it lists only
 * sessions nobody is watching right now (detached / background / parked /
 * idle). The cache stays unfiltered so both pickers share one snapshot — the
 * filter applies at render.
 */
async function resumeSessionsBatch(
  context: vscode.ExtensionContext,
  opts: { title?: string; abandonedOnly?: boolean } = {},
) {
  const select = (cs: ResumeCandidate[]) => (opts.abandonedOnly ? abandonedCandidates(cs) : cs);
  let initial: ResumeCandidate[];
  try {
    initial = select(await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Agents: finding resumable sessions…' },
      fetchResumeCandidates,
    ));
  } catch (err: any) {
      const msg = err?.stderr || err?.message || String(err);
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        vscode.window.showInformationMessage('agents CLI not found. Install with: npm i -g @phnx-labs/agents-cli');
      } else {
        vscode.window.showInformationMessage(`Failed to list sessions: ${msg.slice(0, 160)}`);
      }
    return;
  }

  if (initial.length === 0) {
    vscode.window.showInformationMessage(opts.abandonedOnly ? 'No abandoned sessions found' : 'No sessions found');
    return;
  }

  const quickPick = vscode.window.createQuickPick<ResumeCandidateItem>();
  quickPick.title = opts.title ?? 'Agents: Resume';
  quickPick.canSelectMany = true;
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  // The picker's memory of what the user turned off, carried across list swaps
  // by nextPreselection (which owns the rules and is unit-tested).
  const unticked = new Set<string>();
  let rendered: ResumeCandidate[] = [];
  const applyItems = (candidates: ResumeCandidate[]) => {
    // Assigning items resets the checks, so carry the user's current selection
    // across the swap; newly-seen detached sessions still get pre-ticked.
    const checked = new Set(
      quickPick.selectedItems.map((i) => i.candidate?.id).filter((id): id is string => !!id),
    );
    const preselected = nextPreselection({ previous: rendered, checked, next: candidates, unticked });
    const items = resumeCandidateItems(candidates, preselected);
    quickPick.items = items;
    // `picked` alone does not populate `selectedItems`, which is what onDidAccept
    // reads and what the "N Selected" counter shows — assign it explicitly or the
    // pre-ticked rows resolve to an empty selection.
    quickPick.selectedItems = items.filter((i) => i.candidate && preselected.has(i.candidate.id));
    rendered = candidates;
    quickPick.placeholder = 'Select sessions to reopen, each in its own tab';
  };
  applyItems(initial);

  let pickerDisposed = false;

  let chosen: ResumeCandidate[];
  try {
    chosen = await new Promise<ResumeCandidate[]>((resolve) => {
      // VS Code fires onDidHide for the hide() on accept too — only the hide
      // WITHOUT an accept is a cancel.
      let accepted = false;
      quickPick.onDidAccept(() => {
        accepted = true;
        resolve(quickPick.selectedItems.map((i) => i.candidate).filter((c): c is ResumeCandidate => !!c));
        quickPick.hide();
      });
      quickPick.onDidHide(() => { if (!accepted) resolve([]); });
      quickPick.show();
    });
  } finally {
    pickerDisposed = true;
    quickPick.dispose();
  }

  if (chosen.length === 0) return;

  let opened = 0;
  for (const c of chosen) {
    // Sequential, not Promise.all: each open awaits its terminal's promptReady
    // before typing the resume command, and racing them interleaves the sends.
    if (await openResumedSessionTerminal(context, c)) opened++;
  }
  vscode.window.setStatusBarMessage(
    `Resumed ${opened} session${opened === 1 ? '' : 's'}`,
    4000,
  );
}

/**
 * `Agents: Resume in Best Profile` — reopen the ACTIVE tab's session via
 * `agents run auto`: the CLI resolves host (affinity) → harness (cross-harness
 * headroom) → account (balanced) and fails loud in the fresh terminal when
 * nothing is healthy. Same launch→ready→/continue flow as the Pick-Harness
 * resume (launchResumeTerminal). Fork-style: the original tab is left running.
 */
async function resumeCurrentInBestProfile(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }
  const terminalEntry = terminals.getByTerminal(activeTerminal);
  if (!terminalEntry?.sessionId) {
    vscode.window.showInformationMessage('Active terminal has no session to resume');
    return;
  }
  const agentKey = terminalEntry.agentType
    || prefixToAgentType(terminalEntry.agentConfig?.prefix ?? null);
  if (!agentKey || !supportsPrewarming(agentKey)) {
    return;
  }
  const builtIn = BUILT_IN_AGENTS.find(a => a.key === agentKey);
  if (!builtIn) {
    vscode.window.showInformationMessage(`No built-in agent config for ${agentKey}`);
    return;
  }

  // `--session-id` pins the NEW session id; the CLI honors it only when it
  // picks claude (claude-only flag) and ignores it otherwise. The harness is
  // unknown at spawn: stamp the outgoing harness as the prior (the session
  // feed's read-back corrects it) and arm the claude session-file fast path
  // optimistically — any other pick simply never fires that watch and the
  // generic process probe resolves agentReady.
  const newSessionId = randomUUID();
  const host = terminalEntry.host;
  await launchResumeTerminal(context, {
    builtIn,
    stampAgentKey: agentKey,
    armAgentKey: 'claude',
    launchCmd: buildAutoRunLaunchCommand({ host, sessionId: newSessionId }),
    newSessionId,
    oldSessionId: terminalEntry.sessionId,
    host,
    statusMessage: `Resumed via agents run auto${host ? ` on ${host}` : ''} · ${newSessionId.slice(0, 8)}`,
  });
}

/**
 * The active terminal's tracked entry for the resume-current commands, with
 * the two "nothing to resume" toasts already handled. Requires a session id:
 * without one there is no transcript to point the new tab at.
 */
function activeSessionTerminalEntry(): terminals.EditorTerminal | undefined {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return undefined;
  }
  const entry = terminals.getByTerminal(activeTerminal);
  if (!entry?.sessionId) {
    vscode.window.showInformationMessage('Active terminal has no session to resume');
    return undefined;
  }
  return entry;
}

/**
 * `Agents: Resume (Pick Host)` — reopen the ACTIVE tab's session on another
 * device. Only the host changes: the harness and its pinned version stay, so
 * the host picker is the one decision the user makes. Transcripts sync
 * fleet-wide, so `agents run --host <picked> --resume <id>` picks the session
 * up wherever it lands (see buildVersionedResumeCommand).
 *
 * Deliberate divergence from the batch path: no `cwd` is passed, so the new
 * tab opens in the current workspace rather than the session's own directory.
 * EditorTerminal doesn't track a cwd, and the session's directory may not
 * exist on the picked device anyway — a cross-host move can't promise it.
 */
async function resumeCurrentPickHost(context: vscode.ExtensionContext) {
  const entry = activeSessionTerminalEntry();
  if (!entry) return;
  const agentKey = entry.agentType || prefixToAgentType(entry.agentConfig?.prefix ?? null);
  if (!agentKey || !agentKeyFromSession(agentKey)) {
    vscode.window.showInformationMessage(`Cannot resume sessions of type ${agentKey || 'unknown'}`);
    return;
  }
  const currentHost = entry.host ?? 'this Mac';
  const pick = await pickLaunchHost(context, `Resume ${agentKey} on… (currently: ${currentHost})`, agentKey);
  if (pick.cancelled) return;
  const sessionId = entry.sessionId!;
  const opened = await openResumedSessionTerminal(context, {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: agentKey,
    version: entry.version ?? entry.statusVersion,
    account: entry.account,
    host: pick.host,
  });
  if (opened) {
    vscode.window.setStatusBarMessage(
      `Resuming ${agentKey} on ${pick.host ?? 'this Mac'} · ${sessionId.slice(0, 8)}`,
      4000,
    );
  }
}

/**
 * `Agents: Resume (Pick Harness)` — reopen the ACTIVE tab's session in a
 * different harness on the SAME device. Native `--resume` only works inside
 * the harness that wrote the transcript, so the new harness gets the old
 * session through the universal continue replay (buildResumeInput → the agent
 * loads the transcript via `agents sessions <id>` and keeps working).
 */
async function resumeCurrentPickHarness(context: vscode.ExtensionContext) {
  const entry = activeSessionTerminalEntry();
  if (!entry) return;
  const currentAgent = entry.agentType || prefixToAgentType(entry.agentConfig?.prefix ?? null);
  // Signed-in counts are a LOCAL read; for an offloaded tab this box can't see
  // the device's installs, so the list falls back to the unranked full set and
  // the launch fails loud on the device if the harness is missing there.
  const inventories = entry.host
    ? {}
    : await fetchAgentInventories(BUILT_IN_AGENTS.filter((a) => a.key !== 'shell').map((a) => a.key));
  const options = buildHarnessOptions(BUILT_IN_AGENTS, inventories, currentAgent ?? undefined);
  if (options.length === 0) {
    vscode.window.showInformationMessage('No other harness to resume in');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: o.title,
      description: o.agent,
      detail: o.signedInCount > 0
        ? `${o.signedInCount} signed-in version${o.signedInCount === 1 ? '' : 's'}${o.healthyCount > 0 ? ` · ${o.healthyCount} with usage` : ''}`
        : undefined,
      option: o,
    })),
    {
      title: `Resume in…${currentAgent ? ` (from ${currentAgent})` : ''}`,
      placeHolder: 'Pick the harness to continue this session in',
      matchOnDescription: true,
    },
  );
  if (!picked) return;
  await launchResumeInHarness(context, {
    agentKey: picked.option.agent,
    host: entry.host,
    oldSessionId: entry.sessionId!,
  });
}

/** Everything the shared resume launch needs to open and arm the fresh tab. */
interface ResumeLaunchPlan {
  /** Built-in agent whose icon/prefix/title the fresh tab borrows. */
  builtIn: (typeof BUILT_IN_AGENTS)[number];
  /** Harness stamped on the terminal entry at spawn. */
  stampAgentKey: string;
  /** Harness the readiness session-file fast path arms for. */
  armAgentKey: string;
  launchCmd: string;
  newSessionId: string;
  oldSessionId: string;
  host?: string;
  statusMessage: string;
}

/**
 * Open a fresh tab, send the plan's launch command once the prompt is ready,
 * then feed it the OLD session through the universal continue replay once the
 * TUI is live. Shared by `Agents: Resume (Pick Harness)` and `Agents: Resume
 * in Best Profile`.
 *
 * Fork-style contract: the original tab is left running. Non-claude targets
 * reuse the old session id (only Claude can pin a fresh one up front), so two
 * live processes can share one transcript — same contract as `Agents: Fork`.
 */
async function launchResumeTerminal(
  context: vscode.ExtensionContext,
  plan: ResumeLaunchPlan,
): Promise<void> {
  const agentConfig = createAgentConfig(
    context.extensionPath,
    plan.builtIn.title,
    plan.builtIn.command,
    plan.builtIn.icon,
    plan.builtIn.prefix,
  );
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  const terminalId = terminals.nextId(plan.builtIn.prefix);
  const title = buildTerminalTitle(agentConfig.title, undefined, context, plan.newSessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    env: buildAgentTerminalEnv(terminalId, plan.newSessionId, workspacePath),
    isTransient: true,
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);
  terminals.setSessionId(terminal, plan.newSessionId);
  terminals.setAgentType(terminal, plan.stampAgentKey as SessionAgentType);
  if (plan.host) terminals.setHost(terminal, plan.host);
  startAutoLabelPollerForTerminal(terminal, context);

  // Always inline the central continue.md: it works in ANY harness, and we
  // can't know whether the target version's home has the /continue slash
  // command synced (for a remote host we can't even check from here).
  let centralContinueMdBody: string | null = null;
  try {
    centralContinueMdBody = fsSync.readFileSync(
      path.join(os.homedir(), '.agents-system', 'commands', 'continue.md'),
      'utf-8',
    );
  } catch {
    centralContinueMdBody = null;
  }
  const resumeInput = buildResumeInput(plan.oldSessionId, false, centralContinueMdBody);

  try {
    await readiness.waitFor(terminal, 'promptReady');
  } catch (err) {
    console.warn(`[RESUME] promptReady wait FAILED: ${err} — sending launch anyway`);
  }
  terminal.sendText(plan.launchCmd);
  readiness.armAgentReady(terminal, {
    agentKey: plan.armAgentKey,
    sessionId: plan.newSessionId,
    cwd: workspacePath,
  });
  terminal.show();

  // Type the payload, then Enter as a separate keystroke — Claude's Ink TUI
  // needs the explicit `\r`, and multi-line input swallows a same-tick one.
  const submitToTui = () => {
    terminal.sendText(resumeInput, false);
    setTimeout(() => terminal.sendText('\r', false), 300);
  };
  readiness.waitFor(terminal, 'agentReady').then(submitToTui).catch((err) => {
    console.error(`[RESUME] agentReady wait FAILED: ${err}`);
    vscode.window.showErrorMessage('Failed to resume: agent did not become ready.');
  });

  vscode.window.setStatusBarMessage(plan.statusMessage, 5000);
}

/**
 * `Agents: Resume (Pick Harness)` launch: `agents run <harness> --interactive`
 * (balanced rotation picks the account — the user is switching harness, not
 * account), on the session's device when offloaded.
 */
async function launchResumeInHarness(
  context: vscode.ExtensionContext,
  opts: { agentKey: string; host?: string; oldSessionId: string },
): Promise<void> {
  const builtIn = BUILT_IN_AGENTS.find((a) => a.key === opts.agentKey);
  if (!builtIn) {
    vscode.window.showInformationMessage(`No built-in agent config for ${opts.agentKey}`);
    return;
  }
  // Only Claude can pin its new session id up front (--session-id), which
  // gives readiness an exact jsonl to watch; other harnesses reuse the old id
  // and the generic process probe.
  const newSessionId = opts.agentKey === 'claude' ? randomUUID() : opts.oldSessionId;
  await launchResumeTerminal(context, {
    builtIn,
    stampAgentKey: opts.agentKey,
    armAgentKey: opts.agentKey,
    launchCmd: buildAgentRunLaunchCommand(
      opts.agentKey,
      opts.host,
      opts.agentKey === 'claude' ? newSessionId : null,
    ),
    newSessionId,
    oldSessionId: opts.oldSessionId,
    host: opts.host,
    statusMessage: `Resuming in ${opts.agentKey}${opts.host ? ` on ${opts.host}` : ''} · ${opts.oldSessionId.slice(0, 8)}`,
  });
}

interface TerminalQuickPickItem extends vscode.QuickPickItem {
  terminal: vscode.Terminal;
  lastActivityMs?: number;
}

async function getSessionPreviewForEntry(
  entry: terminals.EditorTerminal,
  workspacePath?: string
): Promise<{ firstUserMessage?: string; lastUserMessage?: string; lastActivityMs?: number; messageCount: number } | null> {
  if (!entry.sessionId) return null;
  const agentType = entry.agentType || prefixToAgentType(entry.agentConfig?.prefix ?? null);
  if (!agentType) return null;

  const sessionPath = await getSessionPathBySessionId(
    entry.sessionId,
    agentType,
    workspacePath
  );
  if (!sessionPath) return null;

  if (agentType === 'opencode') {
    return await getOpenCodeSessionPreviewInfo(sessionPath);
  }
  if (agentType === 'cursor') {
    return await getCursorSessionPreviewInfo(sessionPath);
  }
  return await getSessionPreviewInfo(sessionPath);
}

function cycleAgentTerminal(direction: 1 | -1) {
  const agentEntries = terminals.getAllTerminals().filter(e => e.agentConfig);
  if (agentEntries.length === 0) return;

  const active = vscode.window.activeTerminal;
  const currentIdx = active ? agentEntries.findIndex(e => e.terminal === active) : -1;
  const startIdx = currentIdx === -1 ? (direction === 1 ? -1 : 0) : currentIdx;
  const nextIdx = (startIdx + direction + agentEntries.length) % agentEntries.length;

  agentEntries[nextIdx].terminal.show();
}

async function goToTerminal(context: vscode.ExtensionContext) {
  const allEntries = terminals.getAllTerminals();
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const items: TerminalQuickPickItem[] = [];
  const previewPromises: Array<{ itemIndex: number; entry: terminals.EditorTerminal; promise: Promise<{ firstUserMessage?: string; lastUserMessage?: string; lastActivityMs?: number; messageCount: number } | null> }> = [];

  const display = getDisplayPrefs(context);
  const extensionPath = context.extensionPath;

  for (const entry of allEntries) {
    if (!entry.agentConfig) continue;

    const effectiveTitle = entry.label || entry.autoLabel || 'Untitled';
    const itemIndex = items.length;

    items.push({
      label: effectiveTitle,
      description: '',
      detail: '',
      iconPath: buildIconPath(entry.agentConfig.title, extensionPath) ?? undefined,
      terminal: entry.terminal
    });

    if (entry.sessionId) {
      previewPromises.push({
        itemIndex,
        entry,
        promise: getSessionPreviewForEntry(entry, workspacePath)
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('No agent terminals open');
    return;
  }

  const previewResults = await Promise.all(previewPromises.map(p => p.promise));
  for (let i = 0; i < previewPromises.length; i++) {
    const previewPromise = previewPromises[i];
    const entry = previewPromise.entry;
    const idx = previewPromise.itemIndex;
    const info = previewResults[i];
    if (info) {
      if (!entry.label && !entry.autoLabel && info.firstUserMessage) {
        const words = extractFirstNWords(info.firstUserMessage, 5);
        const ticket = extractLinearTicketId(info.firstUserMessage);
        const generatedTitle = ticket && words ? `${ticket} ${words}` : (ticket ?? words);
        if (generatedTitle) {
          terminals.setAutoLabel(entry.terminal, generatedTitle);
          items[idx].label = generatedTitle;
        }
      }

      if (info.lastActivityMs) {
        const diffMs = Date.now() - info.lastActivityMs;
        items[idx].description = diffMs < 60_000 ? 'Just now' : formatRelativeTime(info.lastActivityMs);
        items[idx].lastActivityMs = info.lastActivityMs;
      }

      const parts: string[] = [];
      if (info.firstUserMessage) parts.push(truncateText(info.firstUserMessage, 80));
      if (info.messageCount > 0) parts.push(`(${info.messageCount})`);
      items[idx].detail = parts.join(' ');
    }
  }

  items.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));

  const maxLabelLen = items.reduce((m, i) => Math.max(m, i.label.length), 0);
  const targetLen = maxLabelLen + 6;
  for (const item of items) {
    if (item.description) {
      const padCount = Math.max(1, targetLen - item.label.length);
      item.label = item.label + '\u00a0'.repeat(padCount);
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Go to terminal',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (selected) {
    selected.terminal.show();
  }
}

export async function openSingleAgentWithQueue(
  context: vscode.ExtensionContext,
  agentConfig: Omit<AgentConfig, 'count'>,
  messages: string[],
  // `cwd` starts the local terminal and, for an ordinary `host` launch, is sent
  // as portable `--cwd` for agents-cli to re-root. `remoteCwd` is already exact
  // on `host` and is reserved for a picked historical session.
  // `viewColumn` places the new tab: `Active` (the default) takes over the
  // current group, `Beside` splits so the launch sits next to what spawned it.
  opts?: { cwd?: string; remoteCwd?: string; mode?: AgentLaunchMode; sessionId?: string; strategy?: RunStrategy; host?: string; local?: boolean; viewColumn?: vscode.ViewColumn }
): Promise<{ terminalId: string; sessionId: string | null }> {
  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: opts?.viewColumn ?? vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const terminalId = terminals.nextId(agentConfig.prefix);
  // An explicit cwd (task dispatch resolved the task's repo to a local clone)
  // pins the terminal there; otherwise use the workspace folder.
  const cwd = opts?.cwd ?? workspaceFolder;

  // Determine agent key and handle session ID
  const builtInDef = getBuiltInByPrefix(agentConfig.prefix);
  const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;
  const defaultModel = agentKey ? settings.getDefaultModel(context, agentKey) : undefined;

  let command = agentConfig.command;
  let sessionId: string | null = null;
  let opencodeSessionsBefore: string[] | null = null;

  if (agentKey === 'opencode') {
    opencodeSessionsBefore = await listOpencodeSessions(cwd);
  }

  // Route every agent runner through `agents run <agent> --interactive` so
  // `--strategy balanced --mode auto` applies uniformly (shell is the only
  // non-runner). Claude gets a pre-generated session id for the resume flow; other
  // agents discover their session post-spawn. opts?.mode defaults to 'auto'
  // (writable-but-gated) inside buildAgentLaunchCommand when no mode is supplied.
  const targetHost = opts?.host && opts.host !== 'local' ? opts.host : undefined;
  if (agentKey && usesManagedAgentLaunch(agentKey, targetHost)) {
    if (agentKey === 'claude') {
      // Claude: generate session ID at open time; others are discovered post-spawn.
      // A caller (dispatch) may pre-supply the id so it can watch that exact
      // session file for a plan / completion afterwards.
      sessionId = opts?.sessionId ?? generateClaudeSessionId();
      command = buildAgentLaunchCommand(agentKey, sessionId, defaultModel, undefined, undefined, opts?.strategy, opts?.mode, {
        host: targetHost,
        local: opts?.local,
        cwd: targetHost && !opts?.remoteCwd ? cwd : undefined,
        remoteCwd: opts?.remoteCwd,
      });
    } else {
      command = buildAgentLaunchCommand(agentKey, null, defaultModel, undefined, undefined, opts?.strategy, opts?.mode, {
        host: targetHost,
        local: opts?.local,
        cwd: targetHost && !opts?.remoteCwd ? cwd : undefined,
        remoteCwd: opts?.remoteCwd,
      });
    }
  }

  const title = buildTerminalTitle(agentConfig.title, undefined, context, sessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: editorLocation,
    name: title,
    env: buildAgentTerminalEnv(terminalId, sessionId, cwd),
    cwd: opts?.cwd ? cwd : undefined,
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  if (targetHost) terminals.setHost(terminal, targetHost);
  readiness.registerTerminal(terminal);

  // Track session ID and agent type. Any known harness is tracked, not just the
  // prewarm five (#1747) — this feeds the persistence path that restore/reopen
  // read, so grok/kimi/droid/antigravity tabs must be tracked here too or they
  // have nothing to come back to.
  const resumeKey = agentKey ? agentKeyFromSession(agentKey) : null;
  if (resumeKey) {
    // Set agent type unconditionally so the sessionTracker fs watcher can adopt
    // a session id when the CLI writes a fresh rollout/jsonl (Codex 0.124+
    // dropped session id from the TUI banner so this is the only signal).
    terminals.setAgentType(terminal, resumeKey);
    if (sessionId) {
      terminals.setSessionId(terminal, sessionId);
    }
  }

  // Pull focus from the webview so the terminal tab becomes the visible one.
  terminal.show(false);

  // Queue messages
  for (const msg of messages) {
    terminals.queueMessage(terminal, msg);
  }

  if (command) {
    // Always an agent-terminal here, never a shell tab (isShell is always
    // false). wrapNativeAgentCommand closes the tab on a clean exit but keeps
    // it open with a readable status line on a launch failure (RUSH-2593).
    await sendCommandWhenReady(terminal, wrapNativeAgentCommand(command, false));
  }

  // Arm agentReady detection so the session-file fast path can fire.
  readiness.armAgentReady(terminal, agentKey && sessionId
    ? { agentKey, sessionId, cwd }
    : {});

  if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
    detectOpencodeSessionId(terminal, terminalId, cwd, opencodeSessionsBefore, context);
  }

  // Flush queued messages once the agent is ready to accept input.
  // Ink TUIs (Claude) watch for `\r` as Enter; `sendText(text, true)` appends
  // `\n` which types into the input but does NOT submit. See the resume flow
  // around line 2086 for the same workaround.
  // 45s hard-timeout fallback: if agentReady never fires (agent exits early,
  // slow machine), we still attempt delivery so the user sees the prompt.
  const AGENT_READY_FALLBACK_MS = 45_000;
  const flushQueued = () => {
    const queued = terminals.flushQueue(terminal);
    queued.forEach((msg, i) => {
      setTimeout(() => {
        terminal.sendText(msg, false);
        // Multi-line prompts go over the pty as a bracketed paste; a \r sent
        // in the same tick gets consumed as paste content and the input never
        // submits. Let the TUI finish ingesting the paste before Enter.
        setTimeout(() => terminal.sendText('\r', false), 300);
      }, i * 700);
    });
  };
  const fallbackHandle = setTimeout(flushQueued, AGENT_READY_FALLBACK_MS);
  readiness.waitFor(terminal, 'agentReady').then(() => {
    clearTimeout(fallbackHandle);
    flushQueued();
  }).catch(() => {
    // waitFor rejects on timeout — fallback handle already scheduled
  });

  return { terminalId, sessionId };
}

async function openAgentTerminals(context: vscode.ExtensionContext) {
  const agents = getAgentsToOpen(context);

  if (agents.length === 0) {
    vscode.window.showInformationMessage('No agents configured to open on login. Use "Agents" to configure.');
    return;
  }

  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  let totalCount = 0;

  for (const agent of agents) {
    for (let i = 0; i < agent.count; i++) {
      // Generate ID first for env var
      const terminalId = terminals.nextId(agent.prefix);

      // Determine agent key and handle session ID
      const builtInDef = getBuiltInByPrefix(agent.prefix);
      const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;
      const defaultModel = agentKey ? settings.getDefaultModel(context, agentKey) : undefined;

      let command = agent.command;
      let sessionId: string | null = null;
      let opencodeSessionsBefore: string[] | null = null;

      if (agentKey === 'opencode') {
        opencodeSessionsBefore = await listOpencodeSessions(cwd);
      }

      if (agentKey === 'claude') {
        // Claude: generate session ID at open time; others are discovered post-spawn.
        sessionId = generateClaudeSessionId();
        command = buildClaudeLaunchCommand(context, sessionId, defaultModel);
        console.log(`[SESSION] Auto-open Claude with session ID: ${sessionId}`);
      }

      const title = buildTerminalTitle(agent.title, undefined, context, sessionId);

      const terminal = vscode.window.createTerminal({
        iconPath: agent.iconPath,
        location: editorLocation,
        name: title,
        env: buildAgentTerminalEnv(terminalId, sessionId, cwd),
        isTransient: true
      });

      const pid = await terminal.processId;
      terminals.register(terminal, terminalId, agent, pid, context);
      readiness.registerTerminal(terminal);

      // Track session ID for any known harness, not just the prewarm five (#1747):
      // this path also starts the label poller that hydrates the live session id,
      // so a grok/kimi/droid/antigravity tab needs it too to be resumable.
      const resumeKey = agentKey ? agentKeyFromSession(agentKey) : null;
      if (resumeKey) {
        // Set agent type unconditionally so sessionTracker fs watcher can adopt
        // a session id from the CLI's rollout file (Codex 0.124+ banner has none).
        terminals.setAgentType(terminal, resumeKey);
        if (sessionId) {
          terminals.setSessionId(terminal, sessionId);
        }
        startAutoLabelPollerForTerminal(terminal, context);
      }

      if (command) {
        try {
          await readiness.waitFor(terminal, 'promptReady');
        } catch (err) {
          console.warn(`[READINESS] promptReady wait failed: ${err}`);
        }
        if (terminal.shellIntegration) {
          terminal.shellIntegration.executeCommand(command);
        } else {
          terminal.sendText(command);
        }
        readiness.armAgentReady(terminal, agentKey && sessionId
          ? { agentKey, sessionId, cwd }
          : {});
      }
      if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
        detectOpencodeSessionId(terminal, terminalId, cwd, opencodeSessionsBefore, context);
      }
      totalCount++;
    }
  }

  if (totalCount > 0) {
    vscode.window.showInformationMessage(`Opened ${totalCount} agent terminal${totalCount > 1 ? 's' : ''}`);
  }
}

interface FetchAutoLabelOpts {
  force?: boolean;
  useFullConversation?: boolean;
}

function isLocalDeviceName(name: string): boolean {
  return isLocalActiveMapKey(activeMapCacheKey(name));
}

/** Stamp a {label, topic} pair onto the tab — persisted name, else LLM/5-word. */
async function applyLabelSource(
  terminal: vscode.Terminal,
  source: { label: string | null; topic: string | null },
): Promise<string | undefined> {
  const topic = source.topic && !isScaffoldingSessionTopic(source.topic) ? source.topic : null;
  const ticket = topic ? extractLinearTicketId(topic) : null;
  if (source.label) {
    const label = ticket ? `${ticket} ${source.label}` : source.label;
    terminals.setAutoLabel(terminal, label);
    return label;
  }
  if (!topic) return undefined;
  const llmTitle = await generateLabelWithLLM(topic);
  const base = llmTitle ?? extractFirstNWords(topic, 5);
  const autoLabel = ticket && base ? `${ticket} ${base}` : (ticket ?? base);
  if (autoLabel) terminals.setAutoLabel(terminal, autoLabel);
  return autoLabel ?? undefined;
}

/**
 * Auto-label for a tab whose agent runs on another machine.
 *
 * Same two-step shape as the local path — reuse a real persisted name, else
 * summarize the first user message — but both inputs come from
 * `agents sessions <id> [--device <host>] --json`. A ticket id in the first
 * message is prefixed exactly as locally, so a remote tab reads the same as a
 * local one.
 */
async function fetchRemoteAutoLabel(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  host?: string
): Promise<string | undefined> {
  if (!entry.sessionId) return undefined;
  const source = await fetchRemoteSessionLabelSource(entry.sessionId, host);
  if (!source) return undefined;
  return applyLabelSource(terminal, source);
}

async function fetchAndSetAutoLabel(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  opts: FetchAutoLabelOpts = {}
): Promise<string | undefined> {
  const sessionId = entry.sessionId;
  if (!sessionId) return entry.autoLabel;
  if (!opts.force && entry.autoLabel) return entry.autoLabel;

  // `--device auto` never records which box the CLI picked. The watch stream
  // does: stamp the machine so every later lookup (label, resume, identity)
  // routes to the transcript's owner instead of scanning this laptop.
  if (!entry.host) {
    const live = sessionPresentationStore.liveSession(sessionId);
    if (live?.machine && !isLocalDeviceName(live.machine)) {
      terminals.setHost(terminal, live.machine);
      entry = terminals.getByTerminal(terminal) ?? entry;
    }
  }

  // Prefer the live stream (already has topic/label, no extra subprocess).
  // Falls through when the row is not indexed yet or carries only scaffolding.
  if (!opts.useFullConversation) {
    const live = sessionPresentationStore.liveSession(sessionId);
    if (live) {
      const topic = live.topic.trim() && !isScaffoldingSessionTopic(live.topic) ? live.topic.trim() : null;
      // Reuse isDerivedSessionName so a real one-word /rename ("RUSH-2058",
      // "Auth") is kept and only Claude's `<dirname>-<n>` placeholder is dropped.
      const rawLabel = live.label.trim();
      const label = rawLabel && !isDerivedSessionName(rawLabel, live.cwd) ? rawLabel : null;
      if (label || topic) {
        const applied = await applyLabelSource(terminal, { label, topic });
        if (applied) return applied;
      }
    }
  }

  // Offloaded tab: the transcript is on the host, so the local session-file scan
  // and jsonl preview below have nothing to read. Ask the CLI (device-aware, or
  // fleet-wide when the host is still unknown) for the same two inputs.
  if (entry.host) {
    return await fetchRemoteAutoLabel(terminal, entry, entry.host);
  }

  try {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const previewInfo = await getSessionPreviewForEntry(entry, workspacePath);
    const firstUserMessage = previewInfo?.firstUserMessage;
    const ticket = firstUserMessage ? extractLinearTicketId(firstUserMessage) : null;

    // 1) Reuse an existing real label. Claude persists the /status title (set by
    //    Claude itself or the user); readClaudeSessionName returns it unless it's
    //    the derived `<dirname>-<n>` placeholder. This is a clean human summary,
    //    needs no LLM call, and — unlike the summary path below — doesn't require
    //    a captured first message, so a session that already has a name gets it
    //    even before its first turn is recorded. Codex/Gemini/Opencode don't
    //    persist an equivalent, so they fall through to the summary path.
    if (entry.agentType === 'claude') {
      const persistedName = await readClaudeSessionName(sessionId);
      if (persistedName) {
        const claudeLabel = ticket ? `${ticket} ${persistedName}` : persistedName;
        terminals.setAutoLabel(terminal, claudeLabel);
        return claudeLabel;
      }
    }

    // 2) Otherwise summarize the session's activity into a short title. This
    //    needs a first user message to summarize. A `--device auto` tab has no
    //    local transcript — ask the CLI (fleet-wide) instead of giving up.
    if (!firstUserMessage) {
      return await fetchRemoteAutoLabel(terminal, entry);
    }

    const sourceText = opts.useFullConversation && previewInfo?.lastUserMessage
      ? `Initial task:\n${firstUserMessage}\n\nLatest activity:\n${previewInfo.lastUserMessage}`
      : firstUserMessage;

    const llmTitle = await generateLabelWithLLM(sourceText);
    const fallback = extractFirstNWords(firstUserMessage, 5);
    const base = llmTitle ?? fallback;
    const autoLabel = ticket && base ? `${ticket} ${base}` : (ticket ?? base);

    if (autoLabel) {
      terminals.setAutoLabel(terminal, autoLabel);
    }
    return autoLabel ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply harness-owned names from the canonical fleet stream to editor tabs.
 * The stream is already elected once per editor process; this is presentation
 * reconciliation only, never another query or lifecycle loop.
 */
async function syncCanonicalSessionTabLabels(context: vscode.ExtensionContext): Promise<void> {
  const display = getDisplayPrefs(context);
  if (!display.autoLabelInTabTitles) return;

  for (const entry of terminals.getAllTerminals()) {
    if (!entry.sessionId || !entry.agentConfig) continue;
    const live = sessionPresentationStore.liveSession(entry.sessionId);
    if (!live) continue;
    const update = planSessionTabLabelUpdate({
      manualLabel: entry.label,
      autoLabel: entry.autoLabel,
    }, live);
    if (!update) continue;

    if (update.clearManualLabel) {
      await terminals.setLabel(entry.terminal, undefined, context);
    }
    terminals.setAutoLabel(entry.terminal, update.label);

    // Renaming briefly activates a terminal. Apply immediately only to the tab
    // the user is already viewing; an inactive tab stores the new autoLabel and
    // the existing focus handler renders it when that tab is next selected.
    if (vscode.window.activeTerminal !== entry.terminal) continue;
    updateStatusBarForTerminal(entry.terminal, context.extensionPath);
    if (display.showLabelsInTitles) {
      const newTitle = buildTerminalTitle(
        entry.agentConfig.title,
        update.label,
        context,
        entry.sessionId,
      );
      await terminals.renameTerminal(entry.terminal, newTitle);
    }
  }
}

// Un-stick a tab whose label is EXACTLY this session's own derived placeholder
// (Claude's `<dirname>-<n>`, e.g. "muqsitnawaz-91"). On a window reload the
// derived name baked into the tab title gets re-adopted as a sticky manual
// label (terminals.register), which then blocks the auto-label poller forever.
// A genuine label never equals the session's derived name, and old CLIs have no
// derived name — so this only ever clears the placeholder, never a real label.
// It touches only the label + its persisted store entry; the agent process is
// never affected.
async function maybeHealDerivedLabel(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!entry.label || !entry.sessionId || entry.agentType !== 'claude') return;
  const info = await readClaudeSessionNameInfo(entry.sessionId);
  if (info?.derived && info.name === entry.label) {
    await terminals.setLabel(terminal, undefined, context);
  }
}

// A remote tab that launches idless (picked-host Codex) needs its session id
// resolved before it can be labeled. Poll the shared per-host active map fast at
// first so the id lands within seconds of launch (the remote session indexes
// within a few seconds); the poller's own backoff then stretches the interval,
// and it stops entirely once a label is set.
const REMOTE_HYDRATE_POLL_MS = 3_000;

interface AutoLabelPollerOpts {
  /** Poll fast initially — used for idless remote tabs racing the remote index. */
  fast?: boolean;
}

function startAutoLabelPollerForTerminal(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext,
  opts: AutoLabelPollerOpts = {},
): void {
  void armAutoLabelPoller(terminal, context, opts);
}

/**
 * Build the pure-core hooks that let the auto-label poller resolve an idless
 * remote tab's canonical id from the shared per-host active map and then run the
 * host-aware label path. `onHydrated` funnels through applyHydratedSessionId, so
 * the id transition arms labeling for the polled tab and every host sibling
 * exactly as the local SessionStart watcher does.
 */
function remoteAutoLabelHooks(labelsEnabled = true): RemoteAutoLabelHooks {
  return {
    fetchMap: (host) => fetchTerminalIdSessionMap(host),
    needsHydrate: needsSessionIdHydrate,
    canonical: (raw) => canonicalSessionId(raw) ?? '',
    siblings: () => terminals.getAllTerminals().map((t) => ({
      id: t.id,
      host: t.host,
      sessionId: t.sessionId,
    })),
    onHydrated: (tabId, canonicalId) => {
      const t = terminals.getById(tabId);
      if (!t) return;
      applyHydratedSessionId(t.terminal, t, t.agentConfig?.prefix ?? '', canonicalId);
    },
    currentSessionId: (tabId) => terminals.getById(tabId)?.sessionId,
    fetchLabel: async (tabId) => {
      if (!labelsEnabled) return undefined;
      const t = terminals.getById(tabId);
      if (!t) return undefined;
      return fetchAndSetAutoLabel(t.terminal, t);
    },
  };
}

/**
 * Arm the auto-label lifecycle for a tab the moment it gains a canonical session
 * id — the remote-hydration counterpart to the local SessionStart watcher's
 * onSessionChanged. Idempotent (the underlying poller no-ops when one is already
 * running or a real label exists), so it is safe to call on every id transition.
 */
function armLabelingAfterHydration(terminal: vscode.Terminal, entry: terminals.EditorTerminal): void {
  if (!entry.agentType || !extensionContext) return;
  startAutoLabelPollerForTerminal(terminal, extensionContext);
}

async function armAutoLabelPoller(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext,
  opts: AutoLabelPollerOpts = {},
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry || !entry.agentType) return;
  // A tab needs an id before it can be labeled. Local tabs already have one
  // (minted up front / resolved by the SessionStart watcher). A remote offload
  // may still be idless right after launch — its session is not indexed yet — so
  // the poller resolves the id first from the shared per-host active map, exactly
  // as the local watcher resolves it from the state file before arming.
  const remoteIdless = !!entry.host && needsSessionIdHydrate(entry.sessionId);
  if (!entry.sessionId && !remoteIdless) return;
  const display = getDisplayPrefs(context);
  const labelsEnabled = display.autoLabelInTabTitles;
  // Session identity is required by the status bar, table, fork, and resume
  // surfaces. It must hydrate even when optional automatic tab labels are off.
  if (!labelsEnabled && !remoteIdless) return;

  // Heal first: if the sticky label is the derived placeholder, drop it so a
  // real name/topic can resolve below.
  await maybeHealDerivedLabel(terminal, entry, context);

  if ((entry.label || entry.autoLabel) && !remoteIdless) return;

  const intervalMs = opts.fast ? REMOTE_HYDRATE_POLL_MS : undefined;
  terminals.startAutoLabelPoller(terminal, async () => {
    const cur = terminals.getByTerminal(terminal);
    if (!cur) return;

    let autoLabel: string | undefined;
    if (cur.host && needsSessionIdHydrate(cur.sessionId)) {
      // Still idless remote: resolve the id (and host siblings') from the shared
      // active map, then label — bare CX -> canonical UUID -> topic title in one
      // tick, no refocus. The fetch is coalesced per host, so N tabs never open N
      // SSH streams.
      const res = await hydrateRemoteTabTick(cur.id, cur.host, remoteAutoLabelHooks(labelsEnabled));
      autoLabel = res.label;
      if (res.hydratedIds.includes(cur.id) && vscode.window.activeTerminal === terminal) {
        updateStatusBarForTerminal(terminal, context.extensionPath);
      }
      if (!labelsEnabled && res.hydratedIds.includes(cur.id)) {
        terminals.stopAutoLabelPoller(terminal);
        return;
      }
    } else {
      if (!labelsEnabled) {
        terminals.stopAutoLabelPoller(terminal);
        return;
      }
      autoLabel = await fetchAndSetAutoLabel(terminal, cur);
    }

    if (!autoLabel || vscode.window.activeTerminal !== terminal) return;
    updateStatusBarForTerminal(terminal, context.extensionPath);
    // Refresh the tab title too, not just the status bar — otherwise a label
    // that resolves while you're sitting on the tab never shows until the next
    // focus change. Renaming briefly activates the terminal, so this is gated
    // on the terminal already being active (same focus-safe guard as
    // tryFetchLabelOnFocus).
    const display = getDisplayPrefs(context);
    if (display.showLabelsInTitles && display.autoLabelInTabTitles && cur.agentConfig) {
      const newTitle = buildTerminalTitle(
        cur.agentConfig.title,
        autoLabel,
        context,
        cur.sessionId
      );
      await terminals.renameTerminal(terminal, newTitle);
    }
  }, intervalMs);
}

// Arm shell-adoption on an SH terminal: poll its descendant process tree for
// a known agent CLI (claude/codex/gemini/cursor/opencode). On detection,
// re-register the entry as the detected agent so the dashboard, session
// tracker, label generation, autogit, and recap all treat it as that agent.
// The VS Code tab icon is immutable so it keeps the SH chip — internal
// state and downstream display only.
function armShellAdoptionForTerminal(terminal: vscode.Terminal, context: vscode.ExtensionContext): void {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) {
    appendAdoptionLog(`armShellAdoptionForTerminal: "${terminal.name}" not in terminals registry — skipping`);
    return;
  }
  if (entry.agentConfig?.prefix !== 'sh') {
    appendAdoptionLog(`armShellAdoptionForTerminal: "${terminal.name}" prefix=${entry.agentConfig?.prefix}, not 'sh' — skipping`);
    return;
  }

  appendAdoptionLog(`armShellAdoptionForTerminal: calling readiness.armShellAdoption for "${terminal.name}" (id=${entry.id})`);

  readiness.armShellAdoption(terminal, ({ agentKey, sessionId }) => {
    appendAdoptionLog(`armShellAdoptionForTerminal callback: agentKey=${agentKey} sessionId=${sessionId} terminal="${terminal.name}"`);
    const def = getBuiltInByKey(agentKey);
    if (!def) {
      appendAdoptionLog(`armShellAdoptionForTerminal callback: no built-in def for "${agentKey}" — aborting`);
      console.warn(`[ADOPT] No built-in def for agent key "${agentKey}"`);
      return;
    }
    const newConfig = createAgentConfig(
      context.extensionPath,
      def.title,
      def.command,
      def.icon,
      def.prefix
    );
    const adopted = terminals.adoptShellAsAgent(terminal, newConfig, agentKey, sessionId);
    appendAdoptionLog(`armShellAdoptionForTerminal callback: adoptShellAsAgent returned ${adopted}`);
    if (!adopted) return;
    if (sessionId && supportsPrewarming(agentKey)) {
      startAutoLabelPollerForTerminal(terminal, context);
    }
    if (vscode.window.activeTerminal === terminal) {
      updateStatusBarForTerminal(terminal, context.extensionPath);
    }
  });
}

function appendAdoptionLog(msg: string): void {
  try {
    const file = path.join(os.homedir(), '.cache', 'swarmify', 'shell-adoption.log');
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.appendFileSync(file, `${new Date().toISOString()} [ext] ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * Try to fetch and set the auto-label when terminal gains focus.
 * This provides immediate label update instead of waiting for the 5-minute poller.
 * Also updates the terminal tab title if showLabelsInTitles is enabled.
 */
async function tryFetchLabelOnFocus(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) return;

  // Need sessionId and agentType to fetch label
  if (!entry.sessionId || !entry.agentType) return;

  // Heal a stuck derived-placeholder label so focusing the tab re-resolves it.
  await maybeHealDerivedLabel(terminal, entry, context);

  // A label fetched while this tab was unfocused is already on the entry, but
  // the title update is gated on `activeTerminal === terminal` — so focusing
  // later used to no-op and leave the bare agent chip forever.
  const existing = entry.label || entry.autoLabel;
  const autoLabel = existing ?? await fetchAndSetAutoLabel(terminal, entry);
  if (!autoLabel) return;

  // Update status bar
  updateStatusBarForTerminal(terminal, context.extensionPath);

  // Update terminal tab title if showLabelsInTitles is enabled.
  // Bail when the user has navigated away during the async LLM fetch — the
  // rename has to briefly activate this terminal, which switches the visible
  // editor tab. The label is already stored on the entry, so the next time
  // this terminal gets focus the title picks it up.
  const display = getDisplayPrefs(context);
  if (
    display.showLabelsInTitles &&
    display.autoLabelInTabTitles &&
    entry.agentConfig &&
    vscode.window.activeTerminal === terminal
  ) {
    const newTitle = buildTerminalTitle(
      entry.agentConfig.title,
      autoLabel,
      context,
      entry.sessionId
    );
    await terminals.renameTerminal(terminal, newTitle);
  }
}


function formatAgentStatusBarText(
  expandedName: string,
  version: string | undefined,
  account: string | undefined,
  label: string | null,
  sessionId: string | undefined,
  showTrackingHint = false,
): string {
  let text = `Agents: ${expandedName}`;
  if (version) {
    text += ` ${version}`;
  }
  if (account) {
    text += ` <${account}>`;
  }
  if (label) {
    text += ` - ${label}`;
  }
  // Always show the CLI-canonical id (UUID), never a Codex rollout-… stem.
  const displayId = canonicalSessionId(sessionId);
  if (displayId) {
    text += ` (${displayId})`;
  } else if (showTrackingHint) {
    text += ' (tracking session)';
  }
  return text;
}

// Resolve the running session's REAL version + account from the CLI session feed
// (`agents sessions <id> --json`, host-aware) and stamp them on the entry. This is
// the only source that knows which version/account a `--strategy balanced` launch
// actually selected for this session — `agents view` reports only the box-wide
// default install, which is unrelated to a specific terminal and was the cause of
// the status bar showing a wrong version/account (esp. under Remote-SSH, where the
// remote box's default differs from what the session actually ran).
async function tryHydrateSessionIdentity(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  prefix: string,
  sessionId: string,
): Promise<void> {
  // The cached version/account belong to a specific session. Skip only when they
  // are already resolved for THIS session id — a rerun or /clear in the same
  // terminal produces a new id (often a different balanced version/account), and
  // the stale cache must be replaced, not kept.
  if (entry.identitySessionId === sessionId && entry.version && entry.account) return;

  const inflightKey = `${sessionId}@${entry.host ?? 'local'}`;
  if (statusIdentityInFlight.has(inflightKey)) return;
  statusIdentityInFlight.add(inflightKey);

  try {
    const identity = await fetchSessionIdentity(sessionId, entry.host);
    if (!identity) return;
    // The terminal may have moved on to another session while this was queued;
    // never stamp a stale session's identity over the current one.
    if (entry.sessionId && entry.sessionId !== sessionId) return;
    // Apply the resolved record AUTHORITATIVELY, clearing a field the session does
    // not carry. A Kimi/Grok session has no version or account, so a value left
    // over from a prior binding in this terminal (e.g. a stale 2.1.218) must be
    // cleared, not preserved by an `if (identity.version)` guard. The early return
    // above protects an already-resolved identity from a transient partial fetch.
    terminals.setVersion(terminal, identity.version);
    terminals.setAccount(terminal, identity.account);
    // An `agents run auto` rotate spawns with the harness unknown (the CLI
    // picks it at launch) and the outgoing harness stamped as a prior — the
    // feed's record is the truth, so correct the stamp when they differ.
    if (identity.agent && identity.agent !== entry.agentType) {
      terminals.setAgentType(terminal, identity.agent as SessionAgentType);
    }
    // Two distinct markers, because "displayable" and "fully resolved" differ:
    //   - identityAppliedSessionId: the version/account cached above were applied
    //     FOR this session (even if a field is null — Grok has a version but no
    //     account, Kimi has neither). displayIdentity gates on this, so the status
    //     bar shows only the current session's identity and a prior binding's
    //     leftover is withheld.
    //   - identitySessionId: BOTH fields present. The call sites re-invoke this
    //     function while it differs from the live id, so an account that the CLI
    //     indexes a beat after the version (Claude/Codex) is still filled by a
    //     later fetch instead of freezing blank.
    entry.identityAppliedSessionId = sessionId;
    if (identity.version && identity.account) entry.identitySessionId = sessionId;

    if (!agentStatusBarItem || vscode.window.activeTerminal !== terminal) return;
    const rawLabel = entry.label;
    const displayLabel = rawLabel ? rawLabel.replace(/<[^>]*>/g, '').trim() : null;
    const { version, account } = displayIdentity(entry, entry.sessionId);
    agentStatusBarItem.text = formatAgentStatusBarText(
      getExpandedAgentName(prefix),
      version,
      account,
      displayLabel,
      entry.sessionId,
      entry.agentType === 'codex',
    );
  } finally {
    statusIdentityInFlight.delete(inflightKey);
  }
}

const liveSessionInFlight = new Set<string>();

/**
 * Stamp a resolved session id on the tab, refresh identity + status bar.
 * Id is always stored in canonical form (UUID, not a rollout-… stem).
 */
function applyHydratedSessionId(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  prefix: string,
  rawId: string,
): void {
  const liveId = canonicalSessionId(rawId);
  if (!liveId) return;
  if (entry.sessionId !== liveId) {
    terminals.setSessionId(terminal, liveId);
    // `--device auto` never knew the machine at launch. The watch stream does.
    const live = sessionPresentationStore.liveSession(liveId);
    if (!entry.host && live?.machine && !isLocalDeviceName(live.machine)) {
      terminals.setHost(terminal, live.machine);
    }
    // The tab just gained (or corrected to) its canonical id. Arm the auto-label
    // lifecycle now — the same transition the local SessionStart watcher performs
    // via onSessionChanged. Without this, a remote-hydrated tab (e.g. picked-host
    // Codex) kept the bare agent chip because labeling was only ever started when
    // an id was known up front (RUSH-2411). Idempotent: startAutoLabelPoller
    // no-ops when a poller is already running or a real label already exists.
    armLabelingAfterHydration(terminal, entry);
  }
  if (entry.identitySessionId !== liveId) {
    void tryHydrateSessionIdentity(terminal, entry, prefix, liveId);
  }
  if (!agentStatusBarItem || vscode.window.activeTerminal !== terminal) return;
  const rawLabel = entry.label;
  const displayLabel = rawLabel ? rawLabel.replace(/<[^>]*>/g, '').trim() : null;
  const { version, account } = displayIdentity(entry, liveId);
  agentStatusBarItem.text = formatAgentStatusBarText(
    getExpandedAgentName(prefix),
    version,
    account,
    displayLabel,
    liveId,
    entry.agentType === 'codex',
  );
}

/**
 * Resolve the live session id for a tab without per-tab polling thrash.
 *
 * Order:
 *  1. Local pid-tree / SessionStart state file — only when the agent runs on
 *     THIS machine (no host, or --device targeting this host).
 *  2. CLI `agents sessions --active` joined on AGENT_TERMINAL_ID — one fetch
 *     per host, shared across all tabs on that host (TTL + in-flight coalesce,
 *     hard timeout). Uses `--host <device>` for real offloads; never `--where`.
 *
 * Failures leave the id unmapped (blank bar), never invent a wrong id.
 */
async function tryHydrateLiveSessionId(
  terminal: vscode.Terminal,
  prefix: string
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) return;
  const inflightKey = entry.id || `live:${terminal.name}`;
  if (liveSessionInFlight.has(inflightKey)) return;
  liveSessionInFlight.add(inflightKey);

  try {
    // Canonicalize a dirty rollout stem, but do not return merely because the
    // entry already contains a clean UUID. A fresh Codex tab can provisionally
    // adopt an older same-cwd rollout before its own SessionStart row appears;
    // the pid state / AGENT_TERMINAL_ID map below is authoritative and must be
    // allowed to replace that syntactically-valid but wrong id (RUSH-2430).
    if (entry.sessionId && !needsSessionIdHydrate(entry.sessionId)) {
      const cleaned = canonicalSessionId(entry.sessionId);
      if (cleaned && cleaned !== entry.sessionId) {
        applyHydratedSessionId(terminal, entry, prefix, cleaned);
      }
    }

    const mapKey = activeMapCacheKey(entry.host);
    const agentIsLocal = isLocalActiveMapKey(mapKey);

    // (1) Local state-file path — only when the agent process is on this box.
    // A true --device offload's terminal.processId is the local ssh client;
    // reading state files for that pid would bind a stranger's recycled session.
    if (agentIsLocal) {
      const shellPid = await terminal.processId;
      const liveId = await liveSessionIdForShell(shellPid, entry.createdAt);
      if (liveId) {
        applyHydratedSessionId(terminal, entry, prefix, liveId);
        return;
      }
    }

    // (2) Shared CLI stream map joined on this tab's AGENT_TERMINAL_ID.
    // One elected extension window owns `agents sessions watch --json`; every
    // window and tab reads its broadcast projection without another subprocess.
    // The one fetch stamps + arms labeling for this tab AND every host sibling
    // it resolves, so focusing a sibling needs no extra round-trip and each tab
    // enters the same auto-label lifecycle as the local watcher (RUSH-2411).
    const map = await fetchTerminalIdSessionMap(entry.host);
    const hostTabs = terminals.getAllTerminals()
      .filter((t) => (t.host ?? '') === (entry.host ?? ''));
    const plan = planActiveMapHydration(
      map,
      hostTabs.map((t) => ({ id: t.id, host: t.host, sessionId: t.sessionId })),
      { needsHydrate: needsSessionIdHydrate, canonical: (raw) => canonicalSessionId(raw) ?? '' },
    );
    for (const step of plan) {
      const t = terminals.getById(step.id);
      if (!t) continue;
      const stampPrefix = t.terminal === terminal ? prefix : (t.agentConfig?.prefix ?? prefix);
      applyHydratedSessionId(t.terminal, t, stampPrefix, step.canonicalId);
    }
    if (plan.some((step) => step.id === entry.id)) {
      return;
    }

    // Still missing: show tracking hint for Codex-style agents if any.
    if (
      agentStatusBarItem &&
      vscode.window.activeTerminal === terminal &&
      needsSessionIdHydrate(entry.sessionId)
    ) {
      const rawLabel = entry.label;
      const displayLabel = rawLabel ? rawLabel.replace(/<[^>]*>/g, '').trim() : null;
      const { version, account } = displayIdentity(entry, entry.sessionId);
      agentStatusBarItem.text = formatAgentStatusBarText(
        getExpandedAgentName(prefix),
        version,
        account,
        displayLabel,
        entry.sessionId,
        entry.agentType === 'codex' || entry.agentType === 'grok',
      );
    }
  } finally {
    liveSessionInFlight.delete(inflightKey);
  }
}

function updateStatusBarForTerminal(terminal: vscode.Terminal, extensionPath: string) {
  if (!agentStatusBarItem) return;

  const entry = terminals.getByTerminal(terminal);
  const info = identifyAgentTerminal(terminal, extensionPath);

  // If this is an agent terminal, show model/account/session metadata.
  // Format: "Agents: Claude 2.1.118 <user@example.com> - <manual label> (uuid)"
  if (info.isAgent && info.prefix) {
    const expandedName = getExpandedAgentName(info.prefix);
    const sessionId = entry?.sessionId;

    // Show immediate status bar with current data
    const rawLabel = entry?.label;
    const displayLabel = rawLabel ? rawLabel.replace(/<[^>]*>/g, '').trim() : null;
    const { version, account } = displayIdentity(entry, sessionId);
    agentStatusBarItem.text = formatAgentStatusBarText(
      expandedName,
      version,
      account,
      displayLabel,
      sessionId,
      entry?.agentType === 'codex',
    );

    // When we already know the session id (e.g. an offloaded --host tab, where the
    // live-id lookup below can't reach the remote box), resolve its real
    // version/account from the session feed (host-aware), re-fetching when the
    // cached identity is for a different session. We deliberately do NOT fall back
    // to `agents view` machine defaults when there is no id — that showed a version
    // and account unrelated to the running session (the reported bug).
    if (entry && sessionId && entry.identitySessionId !== sessionId) {
      void tryHydrateSessionIdentity(terminal, entry, info.prefix, sessionId);
    }
    // Async-resolve the live session id from the SessionStart hook's state file,
    // then hydrate its identity. Catches the case where the user exited and reran
    // the agent in the same terminal, fired /clear, or ran the agent by hand so
    // entry.sessionId was never stamped — the hook's per-pid file has the truth.
    void tryHydrateLiveSessionId(terminal, info.prefix);

    return;
  }

  // Not an agent terminal - show "Terminal" for regular shells
  agentStatusBarItem.text = 'Agents: Terminal';
}

async function relabelActiveTerminal(context: vscode.ExtensionContext): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('No active terminal to re-label.');
    return;
  }

  const entry = terminals.getByTerminal(terminal);
  if (!entry || !entry.sessionId || !entry.agentType) {
    vscode.window.showInformationMessage('This terminal does not have a session to summarize.');
    return;
  }

  terminals.setAutoLabel(terminal, undefined);

  const newLabel = await fetchAndSetAutoLabel(terminal, entry, {
    force: true,
    useFullConversation: true
  });

  if (!newLabel) {
    vscode.window.showInformationMessage('Could not generate a label from session activity.');
    return;
  }

  updateStatusBarForTerminal(terminal, context.extensionPath);

  const display = getDisplayPrefs(context);
  if (display.showLabelsInTitles && display.autoLabelInTabTitles && entry.agentConfig) {
    const newTitle = buildTerminalTitle(
      entry.agentConfig.title,
      newLabel,
      context,
      entry.sessionId
    );
    await terminals.renameTerminal(terminal, newTitle);
  }
}

function setStatusBarLabelForActiveTerminal(context: vscode.ExtensionContext) {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('No active terminal to set status bar label.');
    return;
  }

  const info = identifyAgentTerminal(terminal, context.extensionPath);
  if (!info.isAgent) {
    vscode.window.showInformationMessage('This terminal is not an agent terminal.');
    return;
  }

  const currentLabel = info.label ?? '';

  vscode.window.showInputBox({
    prompt: 'Set a status bar label for this agent',
    placeHolder: 'Status bar label (max 5 words)',
    value: currentLabel
  }).then(async (input) => {
    if (input === undefined) {
      return;
    }

    // Ensure terminal is registered before setting label
    let entry = terminals.getByTerminal(terminal);
    if (!entry && info.prefix) {
      const def = getBuiltInDefByTitle(info.prefix);
      if (def) {
        const agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
        const id = terminals.nextId(info.prefix);
        const pid = await terminal.processId;
        terminals.register(terminal, id, agentConfig, pid, context);
      }
    }

    const cleaned = sanitizeLabel(input.trim());
    await terminals.setLabel(terminal, cleaned || undefined, context);

    // Update status bar only (don't rename terminal tab)
    updateStatusBarForTerminal(terminal, context.extensionPath);

    // Optionally update tab title when labels are shown in titles
    const display = getDisplayPrefs(context);
    if (display.showLabelsInTitles && info.prefix) {
      const updatedEntry = terminals.getByTerminal(terminal);
      const newTitle = buildTerminalTitle(
        info.prefix,
        cleaned || undefined,
        context,
        updatedEntry?.sessionId || null
      );
      await terminals.renameTerminal(terminal, newTitle);
    }

    // Mirror the label into Claude via /rename when applicable.
    // Only fire when we have a non-empty label and the agent is Claude.
    if (cleaned && info.prefix === CLAUDE_TITLE) {
      terminal.sendText(`/rename ${cleaned}`, true);
    }
  });
}

async function clearActiveTerminal(context: vscode.ExtensionContext) {
  try {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showErrorMessage('No active terminal to clear.');
      return;
    }

    const agentConfig = getAgentConfigFromTerminal(terminal, context);
    if (!agentConfig) {
      vscode.window.showErrorMessage('Could not identify agent type from active terminal.');
      return;
    }

    // Get agent type info for session handling
    const builtInDef = getBuiltInDefByTitle(agentConfig.title);
    const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;

    // 1. Terminate current agent (Ctrl+C twice)
    terminal.show();
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
      text: '\u0003'
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
      text: '\u0003'
    });

    // Wait for the agent to release the pty and the shell prompt to reappear
    readiness.resetAfterAgentExit(terminal);
    try {
      await readiness.waitFor(terminal, 'promptReady');
    } catch (err) {
      console.warn(`[READINESS] promptReady wait after agent exit failed: ${err}`);
    }

    try {
      // 2. Generate new IDs for fresh session
      const newTerminalId = terminals.nextId(agentConfig.prefix);
      let newSessionId: string | null = null;
      let command = agentConfig.command || '';
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const defaultModel = agentKey ? settings.getDefaultModel(context, agentKey) : undefined;

      if (agentKey === 'claude') {
        // Claude: generate UUID on-demand
        newSessionId = generateClaudeSessionId();
        command = buildClaudeLaunchCommand(context, newSessionId, defaultModel);
      }

      // 3. Unregister old entry, re-register with new IDs
      terminals.unregister(terminal);
      const pid = await terminal.processId;
      terminals.register(terminal, newTerminalId, agentConfig, pid, context);

      // 4. Set new session/agent type
      if (agentKey && supportsPrewarming(agentKey)) {
        terminals.setAgentType(terminal, agentKey);
      }
      if (newSessionId && agentKey && supportsPrewarming(agentKey)) {
        terminals.setSessionId(terminal, newSessionId);
      }

      // 5. Clear labels and start fresh poller
      await terminals.setLabel(terminal, undefined, context);
      terminals.setAutoLabel(terminal, undefined);
      startAutoLabelPollerForTerminal(terminal, context);

      // 6. Unpin terminal
      await vscode.commands.executeCommand('workbench.action.unpinEditor');

      // 7. Update title with new session ID chunk
      const newTitle = buildTerminalTitle(agentConfig.title, null, context, newSessionId);
      await terminals.renameTerminal(terminal, newTitle);

      // 8. Restart agent with new session
      terminal.sendText('clear && ' + command);
      readiness.armAgentReady(terminal, agentKey && newSessionId
        ? { agentKey, sessionId: newSessionId, cwd }
        : {});

      // 9. Update status bar
      updateStatusBarForTerminal(terminal, context.extensionPath);

      const agentNum = newTerminalId.split('-').pop() || '';
      const numSuffix = agentNum ? ` agent # ${agentNum}` : ' agent';
      vscode.window.showInformationMessage(`Cleared ${getExpandedAgentName(agentConfig.title)}${numSuffix} (new session)`);
    } catch (sendError) {
      vscode.window.showWarningMessage('Terminal may have been closed. Please open a new agent terminal.');
    }
  } catch (error) {
    console.error('Error clearing terminal:', error);
    vscode.window.showErrorMessage(`Failed to clear terminal: ${error}`);
  }
}

async function reloadActiveTerminal(context: vscode.ExtensionContext) {
  try {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showErrorMessage('No active terminal to reload.');
      return;
    }

    const entry = terminals.getByTerminal(terminal);
    if (!entry || !entry.agentConfig) {
      vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
      return;
    }

    const agentConfig = entry.agentConfig;
    if (agentConfig.prefix) {
      await tryHydrateLiveSessionId(terminal, agentConfig.prefix);
    }
    const sessionId = entry.sessionId;
    const agentType = entry.agentType;

    if (!sessionId || !agentType) {
      vscode.window.showErrorMessage('This terminal does not have session tracking enabled. Reload requires a session ID.');
      return;
    }

    // Any known harness with a transcript can reload, not just the prewarm five —
    // `agents run --resume` resumes grok/kimi/droid/antigravity too (#1747). Only
    // a shell / unknown tab has nothing to reload.
    if (!agentKeyFromSession(agentType)) {
      vscode.window.showErrorMessage('This agent type does not support session reload.');
      return;
    }

    // Prewarm agents use their tuned exit keys; the rest fall back to Ctrl+C twice.
    const exitSequence = exitSequenceFor(agentType);
    const resumeCommand = buildVersionedResumeCommand(agentType, sessionId, entry.version, entry.host);

    terminal.show();
    for (const seq of exitSequence) {
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
        text: seq
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    readiness.resetAfterAgentExit(terminal);
    try {
      await readiness.waitFor(terminal, 'promptReady');
    } catch (err) {
      console.warn(`[READINESS] promptReady wait after agent exit failed: ${err}`);
    }

    terminal.sendText(`clear && ${resumeCommand}`);
    readiness.armAgentReady(terminal, {
      agentKey: agentType,
      sessionId,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });

    updateStatusBarForTerminal(terminal, context.extensionPath);
  } catch (error) {
    console.error('Error reloading terminal:', error);
    vscode.window.showErrorMessage(`Failed to reload terminal: ${error}`);
  }
}

async function updateContextKeys(context: vscode.ExtensionContext): Promise<void> {
  const readerEnabled = settings.getSettings(context).editor?.markdownViewerEnabled ?? true;
  await vscode.commands.executeCommand('setContext', 'agents.readerEnabled', readerEnabled);
}

function updateActiveAgentContextKey(
  terminal: vscode.Terminal | undefined,
  extensionPath: string
): void {
  const isAgent = !!terminal && identifyAgentTerminal(terminal, extensionPath).isAgent;
  vscode.commands.executeCommand('setContext', 'agents.activeIsAgent', isAgent);
}

async function closeActiveAgentWithRecap(context: vscode.ExtensionContext): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    await vscode.commands.executeCommand('workbench.action.terminal.kill');
    return;
  }

  const entry = terminals.getByTerminal(terminal);
  if (entry?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(terminal, entry.agentConfig.prefix);
  }
  const agentType = entry?.agentType;
  const sessionId = entry?.sessionId;
  const version = entry?.version;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Not an agent terminal, or missing info we need — fall back to default close.
  if (!entry?.agentConfig || !sessionId || !agentType || !workspacePath || !isRecapSupported(agentType)) {
    await vscode.commands.executeCommand('workbench.action.terminal.kill');
    return;
  }

  // Launch the headless recap before disposing so the JSONL has stabilized.
  // We await up to the spawn() so we know the child has the file handle;
  // child.unref() inside runRecapHeadless means it survives this function.
  try {
    await runRecapHeadless({
      sessionId,
      agentType,
      version,
      workspacePath,
      extensionPath: context.extensionPath,
    });
  } catch (err) {
    console.warn('[recap] runRecapHeadless failed', err);
  }

  try {
    terminal.dispose();
  } catch (err) {
    console.warn('[recap] terminal.dispose() failed', err);
  }
}

async function detectDefaultAgentTitle(): Promise<string> {
  const candidates = [
    { title: CLAUDE_TITLE, key: 'claude' },
    { title: CODEX_TITLE, key: 'codex' },
    { title: GEMINI_TITLE, key: 'gemini' }
  ];

  for (const candidate of candidates) {
    if (await isAgentInstalled(candidate.key)) {
      return candidate.title;
    }
  }

  return CLAUDE_TITLE;
}

async function maybeRunFirstSetup(context: vscode.ExtensionContext, force = false): Promise<void> {
  const already = context.globalState.get<boolean>('agents.setupComplete', false);
  if (already && !force) {
    const stored = context.globalState.get<string>('agents.defaultAgentTitle');
    if (stored) {
      defaultAgentTitle = stored;
    }
    const storedSecondary = context.globalState.get<string>('agents.secondaryAgentTitle');
    if (storedSecondary) {
      secondaryAgentTitle = storedSecondary;
    }
    return;
  }

  // Set default agents on first setup
  defaultAgentTitle = CLAUDE_TITLE;
  secondaryAgentTitle = CODEX_TITLE;
  await context.globalState.update('agents.defaultAgentTitle', CLAUDE_TITLE);
  await context.globalState.update('agents.secondaryAgentTitle', CODEX_TITLE);

  // Ensure swarm MCP + command is enabled for the detected default agent only
  try {
    const def = getBuiltInDefByTitle(defaultAgentTitle);
    const cliAgent = def && ['claude', 'codex', 'gemini'].includes(def.key) ? def.key as swarm.AgentCli : undefined;
    if (cliAgent) {
      const status = await swarm.getSwarmStatus();
      const agentStatus = status.agents[cliAgent];
      if (agentStatus.cliAvailable && (!agentStatus.mcpEnabled || !agentStatus.commandInstalled)) {
        await swarm.setupSwarmIntegrationForAgent(cliAgent, context);
      }
    }
  } catch {
    // Non-fatal; user can rerun setup
  }

  await context.globalState.update('agents.setupComplete', true);
  vscode.window.showInformationMessage(`Agents setup completed. Default agent: ${defaultAgentTitle}.`);
}

// Git functions are now in ./git.vscode

async function spawnWithPrompt(
  context: vscode.ExtensionContext,
  args?: { agent?: string; prompt?: string }
): Promise<void> {
  let agentKey: string | undefined = args?.agent;
  let prompt: string | undefined = args?.prompt;

  if (!agentKey) {
    const items = BUILT_IN_AGENTS.map(a => ({ label: a.title, description: a.key }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pick agent type' });
    if (!picked) return;
    agentKey = picked.description!;
  }

  if (prompt === undefined) {
    prompt = await vscode.window.showInputBox({ prompt: 'Prompt to send to the new agent' });
    if (prompt === undefined) return;
  }
  if (!prompt.trim()) return;

  const def = getBuiltInByKey(agentKey);
  if (!def) {
    vscode.window.showErrorMessage(`Unknown agent: ${agentKey}`);
    return;
  }

  const agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
  await openSingleAgentWithQueue(context, agentConfig, [prompt]);
}

async function spawnWithContext(context: vscode.ExtensionContext): Promise<void> {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showErrorMessage('No active terminal to continue from.');
    return;
  }

  const entryBefore = terminals.getByTerminal(activeTerminal);
  if (entryBefore?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(activeTerminal, entryBefore.agentConfig.prefix);
  }

  const entry = terminals.getByTerminal(activeTerminal);
  if (!entry?.sessionId) {
    vscode.window.showErrorMessage('No session ID found for the active terminal.');
    return;
  }

  if (!entry.agentConfig) {
    vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
    return;
  }

  await openSingleAgentWithQueue(context, entry.agentConfig, [`/continue ${entry.sessionId}`]);
}

/**
 * `Agents: Fork` — a sibling of the tab you are sitting in, same harness, same
 * transcript, on the machine the session already lives on.
 *
 * `Agents: Fork (Pick Host)` (`pickHost: true`) is the same fork with one extra
 * step: you choose the device first, and the sibling starts THERE. Everything
 * else is deliberately held constant — the harness is the source's harness, and
 * the account still rotates through `--strategy balanced` — so the only variable
 * is the machine. The pair is recorded as a fork edge so the Recap ledger can
 * show parent and fork side by side once they finish.
 */
async function forkCurrentSession(
  context: vscode.ExtensionContext,
  opts: { pickHost?: boolean; intent?: ForkSessionIntent } = {},
): Promise<void> {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showErrorMessage('No active terminal to fork.');
    return;
  }

  const entryBefore = terminals.getByTerminal(activeTerminal);
  if (entryBefore?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(activeTerminal, entryBefore.agentConfig.prefix);
  }

  const entry = terminals.getByTerminal(activeTerminal);
  if (!entry?.agentConfig) {
    vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
    return;
  }

  const source = {
    sessionId: entry.sessionId,
    agentKey: entry.agentType ?? prefixToAgentType(entry.agentConfig.prefix) ?? undefined,
    // Where the TRANSCRIPT is. A moved fork has to read it from here, wherever
    // it ends up running.
    host: entry.host,
    localHost: LOCAL_MACHINE_ID,
  };

  if (opts.pickHost) {
    await handleForkPickHost({
      source,
      pickHost: async (agentKey) => {
        const harness = getBuiltInByKey(agentKey)?.title ?? agentKey;
        return pickLaunchHost(context, `Fork this ${harness} session — run on…`, agentKey);
      },
      openFork: async ({ prompt, strategy, host, local, viewColumn }) => openSingleAgentWithQueue(
        context,
        entry.agentConfig!,
        [prompt],
        { strategy, host, local, viewColumn },
      ),
      recordFork: (edge) => { void recordFork(context, edge); },
      showRejection: showForkRejection,
      // Open the fork as a normal full tab in the active group, not a side
      // split — it is a fresh session, not a pane to sit beside its parent.
      viewColumn: vscode.ViewColumn.Active,
      now: Date.now,
    });
    return;
  }

  // The standard command keeps the source session on its own host.
  const request = buildForkSessionRequest(source, undefined, opts.intent);
  if (!request.ok) {
    showForkRejection(request.reason);
    return;
  }

  // Fork identity/copy semantics belong to agents-cli. Keep only the editor
  // terminal that presents the command and its result.
  const terminal = vscode.window.createTerminal({
    name: `Fork ${shortSessionId(request.sessionId)}`,
    location: { viewColumn: vscode.ViewColumn.Active },
    isTransient: true,
  });
  terminal.show(false);
  await sendCommandWhenReady(
    terminal,
    `agents sessions fork ${shquote(request.sessionId)}${opts.intent === 'recap' ? ' --name recap' : ''}`,
  );
  vscode.window.setStatusBarMessage(`Forking ${shortSessionId(request.sessionId)} through agents-cli`, 5000);
}

function showForkRejection(reason: 'no_session' | 'no_agent'): void {
  vscode.window.showErrorMessage(
    reason === 'no_session'
      ? 'No session ID found for the active terminal.'
      : 'No agent harness found for the active terminal.',
  );
}

/** First segment of a session id — enough to recognize it, short enough for a status line. */
function shortSessionId(sessionId: string): string {
  return sessionId.split('-')[0] ?? sessionId;
}

/**
 * Persist the fork edge. Claude mints its session id at launch, so the pair is
 * complete immediately; every other harness discovers its id after the CLI
 * writes the first transcript line, so we watch the terminal entry until the id
 * lands and record the finished edge then. A fork whose id never appears (the
 * tab was closed first) is recorded idless — an honest "this fork happened",
 * which the ledger skips rather than pairing wrongly.
 */
async function recordFork(
  context: vscode.ExtensionContext,
  edge: ForkEdge & { terminalId: string },
): Promise<void> {
  const { terminalId, ...base } = edge;
  const save = async (forkSessionId: string | null) => {
    const edges = context.globalState.get<ForkEdge[]>(FORK_LINEAGE_KEY, []);
    await context.globalState.update(FORK_LINEAGE_KEY, recordForkEdge(edges, { ...base, forkSessionId }));
  };

  const forkSessionId = await resolveForkSessionId({
    initialSessionId: base.forkSessionId,
    terminalId,
    forkHost: base.forkHost,
    localHost: LOCAL_MACHINE_ID,
    attempts: FORK_ID_WAIT_MS / FORK_ID_POLL_MS,
    wait: () => new Promise(resolve => setTimeout(resolve, FORK_ID_POLL_MS)),
    readLocal: id => terminals.getById(id)?.sessionId ?? null,
    readRemote: async (host, id) => {
      try {
        const { runAgents } = await import('../core/agentsBin');
        return remoteForkSessionId(host, id);
      } catch {
        return null;
      }
    },
  });
  await save(forkSessionId);
}

// A harness that discovers its session id post-spawn writes the first transcript
// line within a few seconds; a minute is generous cover for a cold remote start.
const FORK_ID_POLL_MS = 2_000;
const FORK_ID_WAIT_MS = 60_000;

// --- The session browser (Agents: Fork (Pick Session)) ----------------------
// `Agents: Fork` forks the tab you are sitting in. This is the other half: browse
// every recent transcript — on this machine, or on any fleet device you switch to
// — and fork the one you pick. A row's machine is where its fork runs, so picking
// a session that lives on `yosemite-s0` starts the sibling agent THERE (over
// `agents run --host`), where its transcript actually is.

/** Rows requested from the one device currently shown in the browser. Enough to
 *  reach yesterday's work without turning the picker into a scroll marathon. */
const SESSION_BROWSER_LIMIT = 60;

/**
 * Recent transcripts for the browser. Bare, this is the local index (fast, no
 * SSH). With `device`, the CLI fans the same listing out to that box over SSH and
 * answers with the identical row shape — which is why one parser serves both.
 */
async function listBrowsableSessions(
  device?: string,
  currentSessionId?: string | null,
  currentSessionDevice?: string,
): Promise<BrowsableSession[]> {
  const { runAgents } = await import('../core/agentsBin');
  return loadBrowsableSessions(runAgents, {
    device,
    localMachine: LOCAL_MACHINE_ID,
    limit: SESSION_BROWSER_LIMIT,
    currentSessionId,
    currentSessionDevice,
    quote: shquote,
  });
}

interface SessionBrowserItem extends vscode.QuickPickItem {
  row?: SessionBrowserSessionRow;
}

function toBrowserItems(rows: ReturnType<typeof buildSessionBrowserRows>): SessionBrowserItem[] {
  return rows.map((row) =>
    row.kind === 'group'
      ? { label: row.label, kind: vscode.QuickPickItemKind.Separator }
      : {
          label: row.label,
          description: row.description,
          detail: row.detail,
          row,
        },
  );
}

/** Which machine's sessions the browser is listing. `undefined` = this one. */
async function pickBrowseDevice(context: vscode.ExtensionContext, current: string | undefined): Promise<{ device?: string; cancelled: boolean }> {
  void context;
  const devices = await listRegisteredDevices();
  const items: (vscode.QuickPickItem & { deviceId?: string })[] = [
    {
      label: '$(vm) This machine',
      description: LOCAL_MACHINE_ID,
      picked: !current,
    },
    ...devices
      .filter(d => normalizeHost(d.name) !== LOCAL_MACHINE_ID)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .map(d => ({
        label: `${d.online ? '$(radio-tower)' : '$(circle-slash)'} ${d.name}`,
        description: d.online ? 'online' : 'offline',
        deviceId: normalizeHost(d.name),
      })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Browse sessions on…',
    placeHolder: 'Pick the machine whose sessions to browse',
  });
  if (!picked) return { cancelled: true };
  return { device: picked.deviceId, cancelled: false };
}

/**
 * The browser itself. One QuickPick that reloads in place when you switch device,
 * so the flow stays "open → filter → pick" instead of a wizard. Returns the row
 * the user chose, or null when they dismissed it.
 */
async function pickSessionToFork(
  context: vscode.ExtensionContext,
  currentSessionId: string | null,
  currentSessionDevice?: string,
): Promise<SessionBrowserSessionRow | null> {
  const quickPick = vscode.window.createQuickPick<SessionBrowserItem>();
  const switchDevice: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('server-environment'),
    tooltip: 'Browse another device…',
  };
  const reload: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('refresh'),
    tooltip: 'Reload sessions',
  };
  quickPick.placeholder = 'Pick a session to fork — filter by topic, project, harness or id';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.buttons = [switchDevice, reload];

  try {
    return await runSessionBrowserPicker({
      quickPick,
      title: 'Agents: Fork (Pick Session)',
      switchButton: switchDevice,
      reloadButton: reload,
      localMachine: LOCAL_MACHINE_ID,
      loadItems: async device => {
        const sessions = await listBrowsableSessions(device, currentSessionId, currentSessionDevice);
        const rows = buildSessionBrowserRows(sessions, {
          localMachine: LOCAL_MACHINE_ID,
          browsedMachine: device,
          currentSessionId,
        });
        return toBrowserItems(rows);
      },
      chooseDevice: current => pickBrowseDevice(context, current),
      emptyItem: device => ({ label: `No sessions found on ${device ?? LOCAL_MACHINE_ID}`, alwaysShow: true }),
      errorItem: message => ({ label: `$(error) Could not list sessions: ${message.slice(0, 120)}`, alwaysShow: true }),
    });
  } finally {
    quickPick.dispose();
  }
}

/** Browse sessions once, then fork the selected session. */
async function forkPickedSession(context: vscode.ExtensionContext): Promise<void> {
  await handleForkPickedSession({
    localMachine: LOCAL_MACHINE_ID,
    currentSession: () => {
      const activeTerminal = vscode.window.activeTerminal;
      const entry = activeTerminal ? terminals.getByTerminal(activeTerminal) : null;
      return { sessionId: entry?.sessionId ?? null, device: entry?.host };
    },
    pickSession: (sessionId, device) => pickSessionToFork(context, sessionId, device),
    showError: message => { void vscode.window.showErrorMessage(message); },
    resolveAgentConfig: agentKey => {
      const builtIn = BUILT_IN_AGENTS.find(a => a.key === agentKey);
      return builtIn ? createAgentConfig(
        context.extensionPath,
        builtIn.title,
        builtIn.command,
        builtIn.icon,
        builtIn.prefix,
      ) : undefined;
    },
    launchQueued: async (agentConfig, request) => {
      await openSingleAgentWithQueue(context, agentConfig, [request.prompt], request);
    },
    showStatus: message => { void vscode.window.setStatusBarMessage(message, 3000); },
  });
}

// Store context reference for deactivate
let extensionContext: vscode.ExtensionContext | undefined;

// Restore agent terminals from persisted sessions
// Called after scanExisting() on activation
async function restoreAgentTerminals(context: vscode.ExtensionContext): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  const persisted = terminals.loadPersistedSessions(workspacePath);
  if (persisted.length === 0) return;

  // Check which persisted sessions are NOT properly tracked
  // (VS Code may have restored them but without our icons/env vars)
  const tracked = terminals.getAllTerminals();
  const trackedIds = new Set(tracked.map(e => e.id));

  const toRestore = persisted.filter(
    p => !trackedIds.has(p.terminalId),
  );
  if (toRestore.length === 0) {
    terminals.clearPersistedSessions(workspacePath);
    return;
  }

  // Recreate terminals with proper properties.
  // Note: With isTransient: true, VS Code won't auto-restore terminals,
  // so we don't need to close "broken" restores - we're the only restore path.
  //
  // RUSH-2477: bound the restore. A crash-restart reopens every persisted tab at
  // once, and firing one resume per tab with no cap or stagger is a thundering
  // herd — N tabs became N near-simultaneous resume processes within seconds of
  // boot, which is what overwhelmed the resume path (DB-lock crash, boot-time
  // fleet fan-out). `runStaggered` restores at most RESTORE_MAX_CONCURRENCY at a
  // time, each start after the first spaced by RESTORE_STAGGER_MS.
  const restoreOne = async (session: typeof toRestore[number]): Promise<void> => {
    // Handle shell separately (no built-in def)
    let agentConfig: Omit<import('./agents.vscode').AgentConfig, 'count'>;
    let displayTitle: string;

    if (session.prefix.toLowerCase() === 'sh') {
      agentConfig = createAgentConfig(context.extensionPath, 'SH', '', 'agents.png', 'sh');
      displayTitle = 'SH';
    } else {
      const def = getBuiltInByPrefix(session.prefix);
      if (!def) {
        console.log(`[RESTORE] Unknown prefix: ${session.prefix}, skipping`);
        return;
      }
      agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
      displayTitle = def.title;
    }

    const titleLabel = session.label || session.autoLabel;
    const title = buildTerminalTitle(displayTitle, titleLabel, context, session.sessionId || null);

    const terminal = vscode.window.createTerminal({
      iconPath: agentConfig.iconPath,
      location: { viewColumn: vscode.ViewColumn.Active },
      name: title,
      env: buildAgentTerminalEnv(session.terminalId, session.sessionId || null, workspacePath, session.version, { scrubSensitive: session.prefix.toLowerCase() !== 'sh', kind: session.prefix.toLowerCase() === 'sh' ? 'shell' : 'agent' }),
      isTransient: true
    });

    const pid = await terminal.processId;
    // Carry the tab's original creation time across the reload — the agent it is
    // being restored onto is older than this widget (see register's createdAt).
    terminals.register(terminal, session.terminalId, agentConfig, pid, context, session.label, session.createdAt);
    if (session.autoLabel) terminals.setAutoLabel(terminal, session.autoLabel);
    readiness.registerTerminal(terminal);

    // Preserve the version pin across reloads. The env var above is belt; this
    // is suspenders — without it, `resumeCurrentInBestProfile`'s "already on
    // usable version" short-circuit sees `terminalEntry.version === undefined`
    // and falls through to the full profile switch.
    if (session.version) {
      terminals.setVersion(terminal, session.version);
    }

    if (session.prefix.toLowerCase() === 'sh') {
      armShellAdoptionForTerminal(terminal, context);
    }

    // Restore session tracking metadata if present
    if (session.sessionId && session.agentType) {
      terminals.setSessionId(terminal, session.sessionId);
      terminals.setAgentType(terminal, session.agentType as SessionAgentType);
      // Stamp the host before the poller starts so a restored offloaded tab
      // keeps resolving its label (and its resume) on the machine that owns it.
      if (session.host) {
        terminals.setHost(terminal, session.host);
      }
      startAutoLabelPollerForTerminal(terminal, context);

      // Actually resume the session by sending the resume command. Any known
      // harness resumes here, not just the prewarm five (#1747) — buildVersioned-
      // ResumeCommand routes non-prewarm agents through `agents run --resume`.
      if (agentKeyFromSession(session.agentType)) {
        const resumeCmd = buildVersionedResumeCommand(
          session.agentType,
          session.sessionId,
          session.version,
          session.host
        );
        try {
          await readiness.waitFor(terminal, 'promptReady');
        } catch (err) {
          console.warn(`[READINESS] promptReady wait failed: ${err}`);
        }
        if (terminal.shellIntegration) {
          terminal.shellIntegration.executeCommand(resumeCmd);
        } else {
          terminal.sendText(resumeCmd);
        }
        readiness.armAgentReady(terminal, {
          agentKey: session.agentType,
          sessionId: session.sessionId,
          cwd: workspacePath,
        });
      }
    }
  };

  await runStaggered(toRestore, restoreOne, {
    concurrency: RESTORE_MAX_CONCURRENCY,
    staggerMs: RESTORE_STAGGER_MS,
  });

  terminals.clearPersistedSessions(workspacePath);
  console.log(`[RESTORE] Restored ${toRestore.length} agent terminal(s)`);
}

async function reopenLastClosedSession(context: vscode.ExtensionContext): Promise<void> {
  const closed = terminals.popClosedSession();
  if (!closed) {
    vscode.window.showInformationMessage('No recently closed sessions to reopen.');
    return;
  }

  if (!closed.agentConfig || !closed.sessionId) {
    vscode.window.showInformationMessage('Last closed session has no resumable session.');
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const title = buildTerminalTitle(
    closed.agentConfig.title,
    closed.label,
    context,
    closed.sessionId
  );

  const terminalId = terminals.nextId(closed.prefix);
  const terminal = vscode.window.createTerminal({
    iconPath: closed.agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    env: buildAgentTerminalEnv(terminalId, closed.sessionId, workspacePath, closed.version),
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, closed.agentConfig, pid, context, closed.label);
  readiness.registerTerminal(terminal);

  if (closed.sessionId && closed.agentType) {
    terminals.setSessionId(terminal, closed.sessionId);
    terminals.setAgentType(terminal, closed.agentType);
    if (closed.version) {
      terminals.setVersion(terminal, closed.version);
    }
    if (closed.account) {
      terminals.setAccount(terminal, closed.account);
    }
    // Stamp the host before the poller starts so a reopened offloaded tab keeps
    // resolving its label (and its resume) on the machine that owns it.
    if (closed.host) {
      terminals.setHost(terminal, closed.host);
    }
    startAutoLabelPollerForTerminal(terminal, context);

    // Any known harness reopens, not just the prewarm five (#1747).
    if (agentKeyFromSession(closed.agentType)) {
      const resumeCmd = buildVersionedResumeCommand(
        closed.agentType,
        closed.sessionId,
        closed.version,
        closed.host
      );
      try {
        await readiness.waitFor(terminal, 'promptReady');
      } catch (err) {
        console.warn(`[READINESS] promptReady wait failed: ${err}`);
      }
      if (terminal.shellIntegration) {
        terminal.shellIntegration.executeCommand(resumeCmd);
      } else {
        terminal.sendText(resumeCmd);
      }
      readiness.armAgentReady(terminal, {
        agentKey: closed.agentType,
        sessionId: closed.sessionId,
        cwd: workspacePath,
      });
    }
  }

  terminal.show();
  console.log(`[REOPEN] Reopened session: ${closed.sessionId} (${closed.agentType})`);
}

function initForemanRegistry(context: vscode.ExtensionContext): void {
  // Lazy import to avoid loading the registry before activate() fires.
  const registry = require('./foreman.registry') as typeof import('./foreman.registry');
  let timer: NodeJS.Timeout | undefined;
  const publish = async () => {
    try {
      const snap = await registry.snapshotOwnTerminals();
      await registry.publishLiveTerminals(snap);
    } catch { /* best effort */ }
  };
  // Trailing-edge debounce: a flurry of terminal-state changes (each of which
  // awaits processId + does a registry file read/write) coalesces into a
  // single publish instead of N.
  let debounceTimer: NodeJS.Timeout | undefined;
  const schedulePublish = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = undefined; void publish(); }, 300);
  };
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => schedulePublish()),
    vscode.window.onDidCloseTerminal(() => schedulePublish()),
    vscode.window.onDidChangeTerminalState(() => schedulePublish()),
    { dispose: () => { if (debounceTimer) clearTimeout(debounceTimer); } },
  );
  // Long keepalive: publish() itself skips the disk write when nothing
  // changed and the keepalive window isn't due, so this interval is just a
  // safety net. Kept under STALE_WINDOW_MS (10 min) so peers don't prune us.
  timer = setInterval(publish, 60_000);
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });
  void publish();
}

function initMonitorLeader(context: vscode.ExtensionContext): void {
  // Lazy import to keep activation lean and avoid loading the elector early.
  const leader = require('../monitor/leader') as typeof import('../monitor/leader');
  const { computeWindowId } = require('../core/foreman.windowId') as typeof import('../core/foreman.windowId');
  // process.pid is per-extension-host, so a window reload yields a fresh
  // windowId and leadership is re-elected rather than silently continued.
  const selfId = computeWindowId(vscode.env.sessionId, process.pid);
  leader.electLeader({ selfId, pid: process.pid });
  // Graceful handoff: drop the lease on dispose so a peer takes over at once
  // instead of waiting out the TTL.
  context.subscriptions.push({ dispose: () => leader.disposeLeader() });
}

// Run the monitor host (the broadcast server) ONLY while this window is the
// elected leader (#67). `runOnLeaderOnly` starts it on leadership gain and
// disposes it on loss; the next leader binds the same socket and followers
// auto-reconnect. This is also the seam the migration issues (#68-71) wrap
// their heavy starters in — they are intentionally NOT moved here.
function initMonitorHost(context: vscode.ExtensionContext): void {
  const { runOnLeaderOnly } = require('../monitor/gate') as typeof import('../monitor/gate');
  const { MonitorHost } = require('../monitor/host') as typeof import('../monitor/host');
  const gate = runOnLeaderOnly(() => {
    // detectors enables the centralized readiness probes (#68), the machine-wide
    // session watcher (#69), and the panel/floor
    // snapshot detector (#71) on the leader only. The snapshot detector's teams
    // fetch is vscode-coupled, so it's injected here (host.ts stays vscode-free).
    const host = new MonitorHost({
      detectors: {},
    });
    void host.start().catch((err) => console.error('[MONITOR] host start failed:', err));
    return { dispose: () => { void host.stop().catch(() => {}); } };
  });
  context.subscriptions.push(gate);
}

// The always-on per-window follower (#67). It connects to the monitor, reports
// this window's terminal tuples over the broadcast request channel, and
// resolves broadcast facts back to this window's own `vscode.Terminal` via the
// window-local `editorTerminals` map (never moved out of this window). The
// foreman-registry write (initForemanRegistry) stays as the disconnected-case
// fallback — reportTuples is a no-op until the connection is up.
function initMonitorFollower(context: vscode.ExtensionContext): void {
  const { MonitorFollower } = require('../monitor/follower') as typeof import('../monitor/follower');
  const { computeWindowId } = require('../core/foreman.windowId') as typeof import('../core/foreman.windowId');
  type TerminalTuple = import('../monitor/protocol').TerminalTuple;

  const windowId = computeWindowId(vscode.env.sessionId, process.pid);

  // Resolve a broadcast pid/sessionId back to THIS window's terminal, scanning
  // only the window-local registry (stays per-window per epic #64).
  const resolver = (key: { pid?: number | null; sessionId?: string | null }):
    | vscode.Terminal
    | undefined => {
    for (const entry of terminals.getAllTerminals()) {
      if (key.pid != null && entry.pid === key.pid) return entry.terminal;
      if (key.sessionId && entry.sessionId === key.sessionId) return entry.terminal;
    }
    return undefined;
  };

  const collectTuples = (): TerminalTuple[] => {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    return terminals
      .getAllTerminals()
      .filter((e) => e.terminal.exitStatus === undefined && e.agentConfig)
      .map((e) => ({
        windowId,
        terminalId: e.id,
        pid: e.pid ?? null,
        sessionId: e.sessionId ?? null,
        workspacePath,
        agentType: e.agentType ?? null,
      }));
  };

  let follower: InstanceType<typeof MonitorFollower<vscode.Terminal>>;
  const report = () => {
    if (follower?.connected) void follower.reportTuples(collectTuples());
  };

  follower = new MonitorFollower<vscode.Terminal>({
    windowId,
    resolver,
    // Report as soon as the connection (re)establishes, then on terminal events.
    // On loss, restart local readiness probing so nothing stalls (#68 fallback).
    clientOptions: {
      onStateChange: (s) => {
        if (s === 'connected') report();
        else if (s === 'disconnected' || s === 'closed') readiness.onMonitorDisconnected();
      },
    },
  });

  // Migration wiring (#68, #69): the leader runs the probes/watchers once and
  // broadcasts facts; this window resolves them to its own terminals. The gate
  // predicates make terminalReadiness / sessionTracker suppress their local
  // probing while connected and fall back when not.
  const connected = () => follower.connected;
  readiness.setMonitorConnectivity(connected);
  readiness.setMonitorArmSink({
    armAgent: (pid, agentKey, sessionId) => { void follower.armAgent(pid, agentKey, sessionId); },
    armShellAdoption: (pid) => { void follower.armShellAdoption(pid); },
  });

  const proto = require('../monitor/protocol') as typeof import('../monitor/protocol');
  const factSub = follower.onMonitorEvent((event) => {
    if (proto.isReadinessFact(event)) {
      readiness.ingestReadinessFact(event.payload.pid, event.payload.event);
    } else if (proto.isShellAdoptionFact(event)) {
      const p = event.payload;
      readiness.ingestShellAdoptionFact(p.pid, {
        agentKey: p.agentKey as readiness.ShellAdoptionInfo['agentKey'],
        sessionId: p.sessionId,
        childPid: p.childPid,
      });
    } else if (proto.isSessionCliFact(event)) {
      if (sessionPresentationStore.apply(event.payload)) {
        void settings.refreshFloorFromSessionStream();
        void syncCanonicalSessionTabLabels(context);
      }
    }
  });
  context.subscriptions.push({ dispose: factSub });

  follower.start();

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => report()),
    vscode.window.onDidCloseTerminal(() => report()),
    vscode.window.onDidChangeTerminalState(() => report()),
  );
  const timer = setInterval(report, 60_000);
  (timer as { unref?: () => void })?.unref?.();
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      follower.stop();
    },
  });
}

export async function deactivate(): Promise<void> {
  if (extensionContext) {
    // Persist open agent terminals for restore on next launch (immediate, not debounced)
    terminals.persistNow();
  }

  // Release the monitor lease so another window can take over immediately.
  try {
    const leader = require('../monitor/leader') as typeof import('../monitor/leader');
    leader.disposeLeader();
  } catch { /* best effort */ }

  // Clear internal tracking (don't dispose terminals - let VS Code handle them)
  terminals.clear();
}
