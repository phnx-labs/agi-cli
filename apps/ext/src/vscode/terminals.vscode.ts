// VS Code-dependent terminal state management
// Implements API.md 2-map architecture

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AgentConfig } from './agents.vscode';

import { findAgentInTree, SHELL_ADOPTION_TREE_DEPTH } from '../monitor/readinessDetector';
import type { AgentLauncherKey } from '../core/terminalReadiness';
import { generateTerminalId, resolveRestoredVersion, RunningCounts } from '../core/terminals';
import * as sessionsPersist from '../core/sessions.persist';
import { restoredSessionTabLabels } from '../core/sessionTabLabelSync';
import { getSessionPathBySessionId, getSessionPreviewInfo, getOpenCodeSessionPreviewInfo, getCursorSessionPreviewInfo, SessionPreviewInfo } from './sessions.vscode';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import type { RemoteSession } from '../core/remoteSessions';
import { extractSessionQuickDetails, SessionAttachment, SessionQuickDetails, SessionQuickSummary, SessionSummaryAgentType } from '../core/session.summary';
import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  GEMINI_TITLE,
  OPENCODE_TITLE,
  CURSOR_TITLE,
  SHELL_TITLE,
  getTerminalDisplayInfo,
  TerminalIdentificationOptions,
  prefixToAgentType,
  canonicalToConfigPrefix,
  SessionAgentType
} from '../core/utils';

// getTerminalsByAgentType runs 5x (one per agent type) on every 10s floor poll
// and again on every terminal open/close. Its per-terminal/per-session debug
// lines flooded the console at steady state, so gate them behind an env flag
// (#96). Genuine warn/error logs and one-shot lifecycle logs are left intact.
const TERMINAL_DEBUG = process.env.SWARMIFY_DEBUG_TERMINALS === '1';
function debugLog(...args: unknown[]): void {
  if (TERMINAL_DEBUG) console.log(...args);
}

/**
 * Extract identification options from a VS Code terminal.
 * Used to gather all inputs for getTerminalDisplayInfo.
 */
function extractTerminalIdentificationOptions(terminal: vscode.Terminal): TerminalIdentificationOptions {
  const opts = terminal.creationOptions as vscode.TerminalOptions;
  const env = opts?.env;
  const terminalId = env ? env['AGENT_TERMINAL_ID'] : undefined;
  const sessionId = env ? env['AGENT_SESSION_ID'] : undefined;
  const version = env ? env['AGENT_VERSION'] : undefined;

  // Extract icon filename from iconPath
  let iconFilename: string | null = null;
  if (opts?.iconPath) {
    const icon: any = opts.iconPath;
    if (icon instanceof vscode.Uri) {
      iconFilename = path.basename(icon.fsPath);
    } else if (icon && typeof icon === 'object') {
      // Support { light: Uri; dark: Uri } or direct object with fsPath
      const candidate = icon.light ?? icon.dark ?? icon;
      if (candidate instanceof vscode.Uri || (candidate && typeof candidate.fsPath === 'string')) {
        iconFilename = path.basename(candidate.fsPath);
      }
    }
  }

  return {
    name: terminal.name,
    terminalId: terminalId as string | undefined,
    sessionId: sessionId as string | undefined,
    version: (version as string | undefined) || undefined,
    iconFilename
  };
}

export type TerminalApprovalStatus = 'pending' | 'approved' | 'running' | 'complete' | 'rejected';

// Terminal entry following API.md
export interface EditorTerminal {
  id: string;
  terminal: vscode.Terminal;
  agentConfig: Omit<AgentConfig, 'count'> | null;
  label?: string;           // User-set status bar label (manual via Cmd+L)
  autoLabel?: string;       // Auto-generated label (populated by LLM)
  createdAt: number;
  pid?: number;             // Shell process ID
  messageQueue: string[];   // Queued messages to send after terminal ready
  sessionId?: string;       // CLI session ID (for resume, history reading)
  host?: string;            // Device the agent runs on when offloaded via `agents run --host`;
                            // undefined for a local tab. The session's transcript lives on THAT
                            // machine, so every by-session lookup (label, preview, resume) has to
                            // route through `--host <name>` instead of the local filesystem.
  agentType?: SessionAgentType; // Agent type for session operations
  version?: string;         // Pinned agent version ("2.1.113"); undefined when unknown
  account?: string;         // Resolved account email for this terminal when known
  statusVersion?: string;   // Display-only version from agents-cli metadata
  statusAccount?: string;   // Display-only account from agents-cli metadata
  identitySessionId?: string; // Session id whose version/account are cached above AND both fields resolved; retry gate — re-fetch while the live id differs (rerun / /clear, or account not yet indexed)
  identityAppliedSessionId?: string; // Session id the cached version/account were applied for (even if a field is null); display gate — the status bar shows them only for THIS session, never a prior binding's leftover
  approvalStatus?: 'pending' | 'approved' | 'running' | 'complete'; // Swarm approval status
  autoLabelPollerId?: NodeJS.Timeout; // Poller for auto-label fetch (cleared once label is set)
}

const STATUS_BAR_LABELS_KEY = 'agentStatusBarLabels';

type StatusBarLabelsStorage = { [pid: number]: string };

// Re-export PersistedSession from sessions.persist for external use
export type { PersistedSession } from '../core/sessions.persist';

export function loadStatusBarLabels(context: vscode.ExtensionContext): StatusBarLabelsStorage {
  const stored = context.globalState.get<StatusBarLabelsStorage>(STATUS_BAR_LABELS_KEY);
  return stored || {};
}

export async function saveStatusBarLabel(
  context: vscode.ExtensionContext,
  pid: number,
  label: string | undefined
): Promise<void> {
  const stored = loadStatusBarLabels(context);
  if (label) {
    stored[pid] = label;
  } else {
    delete stored[pid];
  }
  await context.globalState.update(STATUS_BAR_LABELS_KEY, stored);
}

export async function removeStatusBarLabel(
  context: vscode.ExtensionContext,
  pid: number | undefined
): Promise<void> {
  if (pid === undefined) return;
  const stored = loadStatusBarLabels(context);
  delete stored[pid];
  await context.globalState.update(STATUS_BAR_LABELS_KEY, stored);
}

// Recently closed session info for "reopen last session"
export interface ClosedSession {
  terminalId: string;
  prefix: string;
  sessionId?: string;
  /** Device the closed session ran on, so reopening resumes it there. */
  host?: string;
  label?: string;
  agentType?: SessionAgentType;
  version?: string;
  account?: string;
  agentConfig: Omit<AgentConfig, 'count'> | null;
  closedAt: number;
}

const MAX_CLOSED_SESSIONS = 10;
const recentlyClosedSessions: ClosedSession[] = [];

export function pushClosedSession(session: ClosedSession): void {
  recentlyClosedSessions.unshift(session);
  if (recentlyClosedSessions.length > MAX_CLOSED_SESSIONS) {
    recentlyClosedSessions.length = MAX_CLOSED_SESSIONS;
  }
}

export function popClosedSession(): ClosedSession | undefined {
  return recentlyClosedSessions.shift();
}

export function getRecentlyClosedSessions(): readonly ClosedSession[] {
  return recentlyClosedSessions;
}

// Two-map architecture (API.md)
const editorTerminals = new Map<string, EditorTerminal>();
const terminalToId = new WeakMap<vscode.Terminal, string>();
let terminalIdCounter = 0;

// Debounced disk persistence
let persistTimeout: NodeJS.Timeout | null = null;

/**
 * Schedule disk persistence (debounced to batch rapid changes).
 * Call this after any terminal state change.
 */
export function schedulePersist(): void {
  const workspacePath = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  if (persistTimeout) clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => {
    persistSessions(workspacePath);
    persistTimeout = null;
    console.log('[TERMINALS] Persisted sessions to disk');
  }, 500); // 500ms debounce
}

/**
 * Persist immediately (for critical operations like deactivate).
 */
export function persistNow(): void {
  const workspacePath = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  if (persistTimeout) {
    clearTimeout(persistTimeout);
    persistTimeout = null;
  }
  persistSessions(workspacePath);
  console.log('[TERMINALS] Persisted sessions to disk (immediate)');
}

// Accessors

export function getByTerminal(t: vscode.Terminal): EditorTerminal | undefined {
  const id = terminalToId.get(t);
  const entry = id ? editorTerminals.get(id) : undefined;
  debugLog(`[DEBUG getByTerminal] terminal="${t.name}" -> id=${id}, entry.label="${entry?.label}"`);
  return entry;
}

export function getById(id: string): EditorTerminal | undefined {
  return editorTerminals.get(id);
}

/**
 * The live editor-terminal entry for a CLI session id, if one is tracked in
 * this window. Used to reveal the terminal from an approval-waiting
 * notification (RUSH-2039). Skips entries whose process has exited.
 */
export function getBySessionId(sessionId: string): EditorTerminal | undefined {
  if (!sessionId) return undefined;
  for (const entry of editorTerminals.values()) {
    if (entry.sessionId === sessionId && entry.terminal.exitStatus === undefined) {
      return entry;
    }
  }
  return undefined;
}

export function getAllTerminals(): EditorTerminal[] {
  return Array.from(editorTerminals.values());
}

export function isAgentTerminal(t: vscode.Terminal): boolean {
  const entry = getByTerminal(t);
  return entry?.agentConfig !== null && entry?.agentConfig !== undefined;
}

// Mutations

// Generate a unique terminal ID (call before creating terminal for env var)
export function nextId(prefix: string): string {
  return generateTerminalId(prefix, ++terminalIdCounter);
}

// Register a terminal with a pre-generated ID
// IMPORTANT: This function is idempotent - if the terminal is already registered,
// it will skip registration to prevent race conditions from overwriting sessionId
export function register(
  terminal: vscode.Terminal,
  id: string,
  agentConfig: Omit<AgentConfig, 'count'> | null,
  pid?: number,
  context?: vscode.ExtensionContext,
  initialLabel?: string,
  // The tab's ORIGINAL creation time, when one is being restored. A reload or a
  // tmux reattach builds a new vscode.Terminal widget for an agent that has been
  // running for hours, and `createdAt` is what dates that agent's own session
  // records (liveSessionIdForShell) — stamping it "now" would make the still-live
  // agent's SessionStart record look like it predates its own tab and get
  // discarded. Omitted for a genuinely new tab, which is created now by definition.
  createdAt?: number,
): void {
  // Check if terminal is already registered (prevents race condition with onDidOpenTerminal)
  const existingId = terminalToId.get(terminal);
  if (existingId) {
    console.log(`[TERMINALS] Terminal "${terminal.name}" already registered with id=${existingId}, skipping duplicate registration`);
    return;
  }

  console.log(`[DEBUG register] Registering terminal: name="${terminal.name}", id=${id}, pid=${pid}, initialLabel=${initialLabel}`);

  const entry: EditorTerminal = {
    id,
    terminal,
    agentConfig,
    createdAt: createdAt ?? Date.now(),
    pid,
    messageQueue: []
  };

  if (pid !== undefined && context) {
    const persistedLabels = loadStatusBarLabels(context);
    console.log(`[DEBUG register] All persisted labels in globalState:`, JSON.stringify(persistedLabels));
    const persistedLabel = persistedLabels[pid];
    console.log(`[DEBUG register] Persisted label for PID ${pid}: "${persistedLabel}"`);
    if (persistedLabel) {
      entry.label = persistedLabel;
    } else if (initialLabel) {
      entry.label = initialLabel;
      // Also persist this label since we found it on a restored terminal
      saveStatusBarLabel(context, pid, initialLabel);
    }
  } else if (initialLabel) {
    entry.label = initialLabel;
  }

  console.log(`[DEBUG register] Final entry.label: "${entry.label}"`);
  editorTerminals.set(id, entry);
  terminalToId.set(terminal, id);
  console.log(`[DEBUG register] editorTerminals now has ${editorTerminals.size} entries`);

  // Persist to disk
  schedulePersist();
}

export function unregister(terminal: vscode.Terminal): void {
  const id = terminalToId.get(terminal);
  if (id) {
    const entry = editorTerminals.get(id);
    if (entry?.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
    }
    editorTerminals.delete(id);
    terminalToId.delete(terminal);

    // Persist to disk
    schedulePersist();
  }
}

export async function setLabel(
  terminal: vscode.Terminal,
  label: string | undefined,
  context?: vscode.ExtensionContext
): Promise<void> {
  console.log(`[DEBUG setLabel] Setting label for terminal "${terminal.name}" to "${label}"`);
  const entry = getByTerminal(terminal);
  console.log(`[DEBUG setLabel] Found entry: id=${entry?.id}, pid=${entry?.pid}, currentLabel="${entry?.label}"`);
  if (entry) {
    entry.label = label;
    if (entry.pid !== undefined && context) {
      console.log(`[DEBUG setLabel] Persisting label "${label}" for PID ${entry.pid}`);
      await saveStatusBarLabel(context, entry.pid, label);
    }

    // Persist to disk
    schedulePersist();

    stopAutoLabelPoller(terminal);
  } else {
    console.log(`[DEBUG setLabel] No entry found for terminal - label NOT saved!`);
  }
}

export function setAutoLabel(terminal: vscode.Terminal, autoLabel: string | undefined): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.autoLabel = autoLabel;
    if (autoLabel && entry.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
      entry.autoLabelPollerId = undefined;
      console.log(`[TERMINALS] Cleared auto-label poller for terminal "${terminal.name}" - label set: "${autoLabel}"`);
    }
    schedulePersist();
  }
}

// Cap the auto-label poll interval. Once a stable label exists the poller
// stops entirely; until then the interval doubles after each failed poll so a
// terminal whose label never resolves doesn't re-spawn a model subprocess
// every 5 minutes forever.
const AUTO_LABEL_MAX_INTERVAL_MS = 60 * 60 * 1000;

export function startAutoLabelPoller(
  terminal: vscode.Terminal,
  pollFn: () => Promise<void>,
  intervalMs: number = 5 * 60 * 1000
): void {
  const entry = getByTerminal(terminal);
  if (!entry) return;
  if (entry.autoLabelPollerId) return;
  if (entry.autoLabel || entry.label) return;

  // Run immediately on start, then back off for subsequent polls.
  pollFn().catch(() => {});

  let delay = intervalMs;
  const schedule = (): void => {
    entry.autoLabelPollerId = setTimeout(async () => {
      // Stable label exists -> stop the drip entirely.
      if (entry.autoLabel || entry.label) {
        entry.autoLabelPollerId = undefined;
        return;
      }
      await pollFn().catch(() => {});
      if (entry.autoLabel || entry.label) {
        entry.autoLabelPollerId = undefined;
        return;
      }
      // Still unlabeled: back off before trying again.
      delay = Math.min(delay * 2, AUTO_LABEL_MAX_INTERVAL_MS);
      schedule();
    }, delay);
  };
  schedule();
  console.log(`[TERMINALS] Started auto-label poller for terminal "${terminal.name}" (interval: ${intervalMs}ms, backoff cap: ${AUTO_LABEL_MAX_INTERVAL_MS}ms)`);
}

export function stopAutoLabelPoller(terminal: vscode.Terminal): void {
  const entry = getByTerminal(terminal);
  if (entry?.autoLabelPollerId) {
    clearInterval(entry.autoLabelPollerId);
    entry.autoLabelPollerId = undefined;
    console.log(`[TERMINALS] Stopped auto-label poller for terminal "${terminal.name}"`);
  }
}

export function setSessionId(terminal: vscode.Terminal, sessionId: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    const prevSessionId = entry.sessionId;
    entry.sessionId = sessionId;
    if (prevSessionId && prevSessionId !== sessionId) {
      entry.autoLabel = undefined;
      if (entry.autoLabelPollerId) {
        clearInterval(entry.autoLabelPollerId);
        entry.autoLabelPollerId = undefined;
      }
    }
    console.log(`[TERMINALS] Set sessionId for terminal "${terminal.name}": ${sessionId}`);

    // Persist to disk
    schedulePersist();

  } else {
    console.error(`[TERMINALS] FAILED to set sessionId - terminal "${terminal.name}" not found in registry. This may indicate a race condition.`);
  }
}

export function setAgentType(
  terminal: vscode.Terminal,
  agentType: SessionAgentType,
  adoptExistingSession = false,
): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.agentType = agentType;

    // Persist to disk
    schedulePersist();

  } else {
    console.error(`[TERMINALS] FAILED to set agentType - terminal "${terminal.name}" not found in registry.`);
  }
}

// Convert an SH-registered terminal into an agent terminal once the user has
// launched an agent CLI inside it. Mutates the existing entry in place so
// every consumer (dashboard, status bar, session tracker, label generation,
// autogit, swarm) starts treating the tab as the detected agent.
//
// The VS Code tab icon and `creationOptions` are immutable, so the visible
// tab keeps its SH chip — only the internal registry and downstream display
// names update.
//
// Idempotent: a non-SH entry is returned unchanged.
export function adoptShellAsAgent(
  terminal: vscode.Terminal,
  newAgentConfig: Omit<AgentConfig, 'count'>,
  agentType: SessionAgentType,
  sessionId: string | undefined
): boolean {
  const entry = getByTerminal(terminal);
  if (!entry) {
    console.error(`[TERMINALS] adoptShellAsAgent: terminal "${terminal.name}" not in registry`);
    return false;
  }
  if (entry.agentConfig?.prefix !== 'sh') {
    console.log(`[TERMINALS] adoptShellAsAgent: terminal "${terminal.name}" already adopted (prefix=${entry.agentConfig?.prefix}), skipping`);
    return false;
  }

  console.log(`[TERMINALS] Adopting SH terminal "${terminal.name}" (id=${entry.id}) as ${newAgentConfig.title}, sessionId=${sessionId}`);
  entry.agentConfig = newAgentConfig;
  entry.agentType = agentType;
  if (sessionId) {
    entry.sessionId = sessionId;
  }

  schedulePersist();
  return true;
}

/** Record the device an offloaded terminal runs on (see EditorTerminal.host). */
export function setHost(terminal: vscode.Terminal, host: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.host = host;
    schedulePersist();
  } else {
    console.error(`[TERMINALS] FAILED to set host - terminal "${terminal.name}" not found in registry.`);
  }
}

export function setVersion(terminal: vscode.Terminal, version: string | null | undefined): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    // A null/empty version CLEARS the cached value rather than being ignored: a
    // harness the CLI records no version for (Kimi, Grok, …) must not keep a
    // version left over from a prior binding in the same terminal.
    const normalized = version?.trim() || undefined;
    entry.version = normalized;
    entry.statusVersion = normalized;
    schedulePersist();
  } else {
    console.error(`[TERMINALS] FAILED to set version - terminal "${terminal.name}" not found in registry.`);
  }
}

export function setAccount(
  terminal: vscode.Terminal,
  account: string | null | undefined
): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    const normalized = account?.trim();
    entry.account = normalized || undefined;
    entry.statusAccount = normalized || undefined;
  } else {
    console.error(`[TERMINALS] FAILED to set account - terminal "${terminal.name}" not found in registry.`);
  }
}

export function getSessionId(terminal: vscode.Terminal): string | undefined {
  const entry = getByTerminal(terminal);
  return entry?.sessionId;
}

export function getAgentType(terminal: vscode.Terminal): SessionAgentType | undefined {
  const entry = getByTerminal(terminal);
  return entry?.agentType;
}

// Message queue management

export function queueMessage(terminal: vscode.Terminal, message: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.messageQueue.push(message);
  }
}

export function flushQueue(terminal: vscode.Terminal): string[] {
  const entry = getByTerminal(terminal);
  if (entry) {
    const messages = [...entry.messageQueue];
    entry.messageQueue = [];
    return messages;
  }
  return [];
}

// Rename a terminal tab title.
//
// `workbench.action.terminal.renameWithArg` only operates on the active
// terminal, so we have to briefly make `terminal` active. That forcibly
// switches the visible editor tab — if we don't restore the previously
// active terminal afterwards, every async rename (auto-label LLM finishing,
// session-change handler, etc.) yanks focus to a random tab.
export async function renameTerminal(terminal: vscode.Terminal, newName: string): Promise<void> {
  const previouslyActiveTerminal = vscode.window.activeTerminal;
  try {
    terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: newName });
  } catch (err) {
    console.error('[TERMINALS] Failed to rename terminal', err);
  } finally {
    if (
      previouslyActiveTerminal &&
      previouslyActiveTerminal !== terminal &&
      previouslyActiveTerminal.exitStatus === undefined
    ) {
      previouslyActiveTerminal.show(false);
    }
  }
}

// Lifecycle

export async function scanExisting(
  inferAgentConfig: (name: string, knownPrefix?: string | null) => Omit<AgentConfig, 'count'> | null,
  context?: vscode.ExtensionContext,
  onSessionRestored?: (terminal: vscode.Terminal) => void
): Promise<number> {
  console.log('[TERMINALS] Scanning all terminals...');
  let registeredCount = 0;

  // Load persisted sessions for session recovery
  const workspacePath = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  const persistedSessions = workspacePath ? sessionsPersist.getWorkspaceSessions(workspacePath) : [];
  const usedPersistedIds = new Set<string>();
  console.log(`[TERMINALS] Loaded ${persistedSessions.length} persisted sessions`);

  for (const terminal of vscode.window.terminals) {
    console.log(`[TERMINALS] Checking terminal: "${terminal.name}"`);

    // Skip terminals whose process has exited (tab may still be open)
    if (terminal.exitStatus !== undefined) {
      console.log(`[TERMINALS] Process exited, skipping`);
      continue;
    }

    // Skip if already registered
    if (terminalToId.has(terminal)) {
      console.log(`[TERMINALS] Already registered, skipping`);
      continue;
    }

    // Use the central identification function with all available inputs
    const identOpts = extractTerminalIdentificationOptions(terminal);
    const info = getTerminalDisplayInfo(identOpts);
    console.log(`[TERMINALS] Display info for "${terminal.name}": isAgent=${info.isAgent}, prefix=${info.prefix}`);

    if (!info.isAgent || !info.prefix) continue;

    const agentConfig = inferAgentConfig(terminal.name, info.prefix);
    if (!agentConfig) continue;

    const id = identOpts.terminalId || nextId(info.prefix);

    let pid: number | undefined;
    try {
      pid = await terminal.processId;
    } catch (error) {
      console.log(`[TERMINALS] Could not retrieve PID for terminal "${terminal.name}"`);
    }

    const persistedByTerminalId = identOpts.terminalId
      ? persistedSessions.find(p => p.terminalId === identOpts.terminalId)
      : undefined;
    const restoredLabels = restoredSessionTabLabels(info.label || undefined, persistedByTerminalId);
    register(terminal, id, agentConfig, pid, context, restoredLabels.manualLabel);
    if (restoredLabels.autoLabel) setAutoLabel(terminal, restoredLabels.autoLabel);
    registeredCount++;
    console.log(`[TERMINALS] Registered: id=${id}, prefix=${info.prefix}, pid=${pid}, label=${info.label}`);

    // Restore the pinned agent version. Env is the most-recent source of
    // truth (set by resumeCurrentInBestProfile at spawn time), but VS Code
    // can drop `terminal.creationOptions.env` across some reload paths, so
    // we also check the persisted session by terminalId. This lookup MUST
    // run regardless of which sessionId-recovery strategy wins below — a
    // prior version of this code nested the persisted fallback inside
    // Strategy 2 (`if (!sessionId && info.prefix) { ... }`), so Strategy 1
    // succeeding silently skipped version recovery, and Cmd+Shift+J's
    // "already on usable version" short-circuit couldn't fire.
    // Recover the offloaded device BEFORE any host-dependent lookup runs. VS Code
    // restores terminals without our env vars, so `entry.host` is lost on reload
    // unless we rehydrate it from the persisted session here. Without this, a
    // remote session's resume command degrades to a local raw binary and the
    // label poller reads the wrong filesystem (extension.ts restore callers pass
    // `session.host` into buildVersionedResumeCommand; scanExisting is the other
    // reload path that must keep it, RUSH-2047).
    if (persistedByTerminalId?.host) {
      setHost(terminal, persistedByTerminalId.host);
    }

    const pinnedVersion = resolveRestoredVersion(
      identOpts.version,
      persistedByTerminalId?.version
    );
    if (pinnedVersion) {
      setVersion(terminal, pinnedVersion);
    }

    // Restore session tracking - prefer env var sessionId, fallback to sessionChunk from name
    const agentType = prefixToAgentType(info.prefix);
    if (agentType) {
      // Register agent type even when session id is unknown so sessionTracker
      // can adopt new Codex/Claude session files later.
      setAgentType(terminal, agentType, true);
    }
    let sessionId = identOpts.sessionId;

    // Strategy 0 (authoritative): ask the process ACTUALLY running in this
    // pane. env (AGENT_SESSION_ID), the tab-name chunk, and the persisted
    // store are all captured at spawn time and go stale the moment the live
    // session changes (a /continue or a resume/rotate switches the running
    // session id) — and VS Code frequently drops `creationOptions.env` across
    // a Remote-SSH window reload, forcing the recency-based fallbacks below.
    // Those fallbacks match only by agent prefix + "most recent", so on reload
    // a tab can be bound to a SIBLING session (wrong id, account, and version)
    // that merely looks newest. The live process's own `--session-id`/`--resume`
    // arg is the only signal tied to THIS pane, so it wins over every heuristic.
    //
    // Gate on THIS tab's agent: findAgentInTree only returns a descendant of
    // `agentType`, so a nested/stray other-agent process (e.g. a codex spawned
    // under a Claude tab's shell) can never bind this tab to the wrong agent's
    // session. Only override an existing env id when the live id actually
    // disagrees — a matching id is left untouched.
    if (pid !== undefined && agentType) {
      try {
        const live = await findAgentInTree(
          pid,
          SHELL_ADOPTION_TREE_DEPTH,
          agentType as AgentLauncherKey
        );
        if (live?.sessionId && live.sessionId !== sessionId) {
          console.log(
            `[TERMINALS] Live-process sessionId ${live.sessionId} (pid=${pid}, ` +
              `${live.agentKey}) overrides ${sessionId ?? 'none'} from env`
          );
          sessionId = live.sessionId;
        }
      } catch {
        // Process may have exited or the probe failed; fall through to the
        // best-effort heuristics below.
      }
    }

    // Strategy 1: Try to recover from sessionChunk in terminal name
    if (!sessionId && info.sessionChunk && agentType) {
      const sessionPath = await getSessionPathBySessionId(
        info.sessionChunk,
        agentType as 'claude' | 'codex' | 'gemini',
        workspacePath
      );
      if (sessionPath) {
        // Extract full sessionId from file path (filename without extension)
        const filename = path.basename(sessionPath);
        const ext = path.extname(filename);
        sessionId = filename.slice(0, -ext.length);
        console.log(`[TERMINALS] Recovered sessionId from chunk: ${info.sessionChunk} -> ${sessionId}`);
      }
    }

    // Strategy 2: Try to match with persisted session by prefix
    // Use the most recently created persisted session for this prefix that hasn't been used yet
    // Note: info.prefix is canonical (CC, CX), persisted uses config format (cl, cx)
    if (!sessionId && info.prefix) {
      const configPrefix = canonicalToConfigPrefix(info.prefix);
      const matchingSessions = persistedSessions
        .filter(p => p.prefix === configPrefix && p.sessionId && !usedPersistedIds.has(p.terminalId))
        .sort((a, b) => b.createdAt - a.createdAt); // Most recent first

      if (matchingSessions.length > 0) {
        const matched = matchingSessions[0];
        sessionId = matched.sessionId;
        usedPersistedIds.add(matched.terminalId);
        console.log(`[TERMINALS] Recovered sessionId from persisted session: ${matched.terminalId} -> ${sessionId}`);

        // Also recover the agentType if available
        if (matched.agentType && !agentType) {
          setAgentType(terminal, matched.agentType as SessionAgentType);
        }

        // Version recovery for this branch only — when env.terminalId was
        // absent so the persisted-by-terminalId lookup above missed. Prefer
        // the existing pin from env if present.
        if (!pinnedVersion && matched.version) {
          setVersion(terminal, matched.version);
        }

        const matchedLabels = restoredSessionTabLabels(info.label || undefined, matched);
        if (matchedLabels.manualLabel !== getByTerminal(terminal)?.label) {
          await setLabel(terminal, matchedLabels.manualLabel, context);
        }
        if (matchedLabels.autoLabel) setAutoLabel(terminal, matchedLabels.autoLabel);
      }
    }

    if (sessionId) {
      setSessionId(terminal, sessionId);
      console.log(`[TERMINALS] Restored session: sessionId=${sessionId}, agentType=${agentType}`);
      if (onSessionRestored) {
        onSessionRestored(terminal);
      }
    }
  }

  console.log(`[TERMINALS] Scan complete. Registered ${registeredCount} agent terminals.`);
  return registeredCount;
}

// Count running agents
export function countRunning(): RunningCounts {
  const counts: RunningCounts = {
    claude: 0,
    codex: 0,
    gemini: 0,
    opencode: 0,
    cursor: 0,
    shell: 0,
    custom: {}
  };

  for (const terminal of vscode.window.terminals) {
    // Skip terminals whose process has exited (tab may still be open)
    if (terminal.exitStatus !== undefined) continue;

    // Use full identification (name + env + icon) so we keep prefix even when the
    // tab title is just a label (showLabelsInTitles=true) or has been manually renamed.
    const identOpts = extractTerminalIdentificationOptions(terminal);
    const info = getTerminalDisplayInfo(identOpts);
    if (!info.isAgent || !info.prefix) continue;

    switch (info.prefix) {
      case CLAUDE_TITLE:
        counts.claude++;
        break;
      case CODEX_TITLE:
        counts.codex++;
        break;
      case GEMINI_TITLE:
        counts.gemini++;
        break;
      case OPENCODE_TITLE:
        counts.opencode++;
        break;
      case CURSOR_TITLE:
        counts.cursor++;
        break;
      case SHELL_TITLE:
        counts.shell++;
        break;
      default:
        counts.custom[info.prefix] = (counts.custom[info.prefix] || 0) + 1;
        break;
    }
  }

  return counts;
}

// Accurate running counts that verify terminals have active sessions with messages.
// Falls back to countRunning() for shell terminals and unknown terminals.
export async function countActive(workspacePath?: string): Promise<RunningCounts> {
  const openCounts = countRunning();
  const activeCounts: RunningCounts = { ...openCounts, custom: { ...openCounts.custom } };

  const agentKeys = ['claude', 'codex', 'gemini', 'opencode', 'cursor'] as const;
  const checks = agentKeys
    .filter(key => openCounts[key] > 0)
    .map(async (key) => {
      const details = await getTerminalsByAgentType(key, workspacePath);
      const active = details.filter(d => d.messageCount && d.messageCount > 0).length;
      activeCounts[key] = active;
    });

  await Promise.all(checks);
  return activeCounts;
}

// Terminal detail for UI display
export interface TerminalDetail {
  id: string;
  agentType: string;
  label: string | null;
  autoLabel: string | null;
  createdAt: number;
  index: number; // 1-based index within agent type
  sessionId: string | null; // CLI session ID
  firstUserMessage?: string; // First user message (initial task/prompt)
  lastUserMessage?: string; // Last user message from session
  status?: 'running' | 'completed' | 'idle';
  messageCount?: number; // Total message count in session
  firstMessageTimestamp?: string; // ISO-8601 timestamp of first user message
  lastActivityTimestamp?: string; // ISO-8601 timestamp of latest session update
  currentActivity?: string; // Live activity (e.g., "Reading src/auth.ts", "Running npm test")
  quickSummary?: SessionQuickSummary;
  recentFiles?: string[];
  recentFileTimes?: Record<string, number>;
  recentTools?: string[];
  recentToolCalls?: import('../core/session.summary').RecentToolCall[];
  recentEvents?: import('../core/session.summary').RecentEvent[];
  attachments?: SessionAttachment[];
  lastFilePath?: string | null;
  narrative?: string; // Agent's most recent substantive assistant prose (rolling summary line)
  cwd?: string | null;
  branch?: string | null;
  recentFileStats?: Record<string, { added: number; removed: number }>;
  waitingForInput?: boolean;
  approvalStatus?: TerminalApprovalStatus;
  role?: string;
  hint?: string;
  isParent?: boolean;
  parentId?: string | null;
  parentLabel?: string | null;
  children?: string[];
}

function pickMostRecentTimestamp(...timestamps: Array<string | undefined>): string | undefined {
  let newestMs = Number.NEGATIVE_INFINITY;
  let newestIso: string | undefined;

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms > newestMs) {
      newestMs = ms;
      newestIso = new Date(ms).toISOString();
    }
  }

  return newestIso;
}

// Map from lowercase key (used in UI) to prefix (used in terminal names)
const AGENT_KEY_TO_PREFIX: Record<string, string> = {
  claude: 'CC',
  codex: 'CX',
  gemini: 'GX',
  opencode: 'OC',
  cursor: 'CR',
  shell: 'SH'
};

const AGENT_ROLE_HINTS: Record<string, { role: string; hint: string }> = {
  claude: { role: 'lead', hint: 'Strategy and orchestration' },
  codex: { role: 'fix', hint: 'Fast edits and implementation' },
  gemini: { role: 'research', hint: 'Deep research and exploration' },
  cursor: { role: 'trace', hint: 'Debugging and tracing' },
  opencode: { role: 'assist', hint: 'Editor-style help' },
  shell: { role: 'shell', hint: 'Command execution' }
};

const SESSION_SUMMARY_CACHE_MAX = 200;
type SessionSummaryCacheEntry = {
  mtimeMs: number;
  size: number;
  details: SessionQuickDetails;
};
const sessionSummaryCache = new Map<string, SessionSummaryCacheEntry>();

// Shared CLI stream projection keyed by sessionId — the single source for live
// activity and waiting-for-input. This performs no subprocess or local polling.
async function localCliSessionsById(): Promise<Map<string, RemoteSession>> {
  const sessions = sessionPresentationStore.sessions() as RemoteSession[];
  return new Map(sessions.filter((s) => s.sessionId).map((s) => [s.sessionId, s]));
}

const SESSION_CONTENT_TAIL_BYTES = 256 * 1024;

// Bounded-size read for session-summary parsing. The previous implementation
// did a full fs.readFile on every mtime change; for a 50MB Claude session
// changing on every message, the cache invalidated continuously and the
// extension host re-read the full file every dashboard refresh. Capped at
// 256KB tail, which is enough for the head/tail metadata the summary
// extractor uses.
async function readSessionContent(filePath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return '';
    const readStart = Math.max(0, size - SESSION_CONTENT_TAIL_BYTES);
    const buf = Buffer.alloc(size - readStart);
    await handle.read(buf, 0, buf.length, readStart);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

function makeSessionSummaryCacheKey(filePath: string, agentType: SessionSummaryAgentType): string {
  return `${agentType}:${filePath}`;
}

function cacheSessionSummaryEntry(key: string, entry: SessionSummaryCacheEntry): void {
  if (sessionSummaryCache.has(key)) {
    sessionSummaryCache.delete(key);
  }
  sessionSummaryCache.set(key, entry);
  if (sessionSummaryCache.size <= SESSION_SUMMARY_CACHE_MAX) return;
  const oldestKey = sessionSummaryCache.keys().next().value;
  if (oldestKey) {
    sessionSummaryCache.delete(oldestKey);
  }
}

async function getSessionQuickDetailsCached(
  filePath: string,
  agentType: SessionSummaryAgentType
): Promise<SessionQuickDetails | null> {
  let stats: { mtimeMs: number; size: number };
  try {
    const stat = await fs.stat(filePath);
    stats = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }

  const cacheKey = makeSessionSummaryCacheKey(filePath, agentType);
  const cached = sessionSummaryCache.get(cacheKey);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.details;
  }

  const sessionContent = await readSessionContent(filePath);
  if (!sessionContent) return null;

  const details = extractSessionQuickDetails(sessionContent, agentType);
  cacheSessionSummaryEntry(cacheKey, {
    ...stats,
    details,
  });
  return details;
}

// Get terminals filtered by agent type with display details
// Scans VS Code terminals directly to handle restored/unregistered terminals
export async function getTerminalsByAgentType(
  agentType: string,
  workspacePath?: string
): Promise<TerminalDetail[]> {
  const expectedPrefix = AGENT_KEY_TO_PREFIX[agentType];
  const results: TerminalDetail[] = [];
  const sessionPromises: Array<{
    index: number;
    sessionPath: Promise<string | undefined>;
    agentType: 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'antigravity' | 'grok' | 'kimi' | 'droid';
  }> = [];
  let index = 0;

  debugLog(`[getTerminalsByAgentType] Looking for agentType="${agentType}", expectedPrefix="${expectedPrefix}", total terminals=${vscode.window.terminals.length}`);

  for (const terminal of vscode.window.terminals) {
    // Skip terminals whose process has exited (tab may still be open)
    if (terminal.exitStatus !== undefined) continue;

    const identOpts = extractTerminalIdentificationOptions(terminal);
    const info = getTerminalDisplayInfo(identOpts);
    debugLog(`[getTerminalsByAgentType] Terminal "${terminal.name}": info.prefix="${info.prefix}", info.isAgent=${info.isAgent}`);
    if (!info.isAgent || !info.prefix) continue;

    // Match by prefix for built-in agents, or by exact name for custom agents
    const isMatch = expectedPrefix
      ? info.prefix === expectedPrefix
      : info.prefix === agentType;

    if (!isMatch) continue;

    index++;

    // Try to get additional info from our internal map
    const entry = getByTerminal(terminal);
    const resultIndex = results.length;

    debugLog(`[getTerminalsByAgentType] Terminal "${terminal.name}": entry=${entry ? 'found' : 'not found'}, sessionId=${entry?.sessionId || 'null'}, agentType=${entry?.agentType || 'null'}`);

    results.push({
      id: entry?.id || `unregistered-${index}`,
      agentType: agentType,
      label: entry?.label || info.label || null,
      autoLabel: entry?.autoLabel || null,
      createdAt: entry?.createdAt || Date.now(),
      index: index,
      sessionId: entry?.sessionId || null,
      approvalStatus: entry?.approvalStatus || 'pending',
      role: AGENT_ROLE_HINTS[agentType]?.role || 'agent',
      hint: AGENT_ROLE_HINTS[agentType]?.hint || 'Generalist',
      parentId: null,
      parentLabel: null,
      children: []
    });

    // Queue session path lookup if session exists
    if (entry?.sessionId) {
      // Use agentType if available, otherwise infer from agentConfig.prefix
      const sessionAgentType = entry?.agentType || prefixToAgentType(entry?.agentConfig?.prefix ?? null);
      if (sessionAgentType) {
        sessionPromises.push({
          index: resultIndex,
          sessionPath: getSessionPathBySessionId(entry.sessionId!, sessionAgentType, workspacePath),
          agentType: sessionAgentType
        });
      }
    }
  }

  // Resolve all session paths first
  const sessionPaths = await Promise.all(sessionPromises.map(p => p.sessionPath));

  // Live activity + waiting-for-input come from the shared
  // `agents sessions watch --json` projection.
  const cliBySession = await localCliSessionsById();

  // Now fetch preview info in parallel for each session
  const dataPromises = sessionPromises.map(async (p, i) => {
    const sessionPath = sessionPaths[i];
    debugLog(`[getTerminalsByAgentType] Session ${i}: path=${sessionPath || 'NOT FOUND'}, agentType=${p.agentType}`);
    if (!sessionPath) return {
      index: p.index,
      preview: null,
      activity: null,
      sessionMtimeTimestamp: null,
      quickDetails: null,
      waitingForInput: false
    };

    // Use agent-specific preview function
    let previewPromise: Promise<SessionPreviewInfo | null>;
    if (p.agentType === 'opencode') {
      previewPromise = getOpenCodeSessionPreviewInfo(sessionPath);
    } else if (p.agentType === 'cursor') {
      previewPromise = getCursorSessionPreviewInfo(sessionPath);
    } else {
      previewPromise = getSessionPreviewInfo(sessionPath);
    }

    const summaryAgentType = (p.agentType === 'claude' || p.agentType === 'codex' || p.agentType === 'gemini') ? p.agentType : null;
    const [preview, sessionStat] = await Promise.all([
      previewPromise,
      fs.stat(sessionPath).catch(() => null)
    ]);

    const quickDetails = summaryAgentType
      ? await getSessionQuickDetailsCached(sessionPath, summaryAgentType)
      : null;
    // The CLI row is the state engine's verdict: `activity` is the live now-line
    // (set only while the session is working), `waitingForInput` already carries
    // the prose-question freshness decay and the structural AskUserQuestion signal.
    const cli = cliBySession.get(results[p.index].sessionId || '');
    return {
      index: p.index,
      preview,
      activity: cli?.activity || null,
      sessionMtimeTimestamp: sessionStat?.mtime ? sessionStat.mtime.toISOString() : null,
      quickDetails,
      waitingForInput: cli?.waitingForInput === true
    };
  });

  const dataResults = await Promise.all(dataPromises);

  // Populate results with fetched data
  for (const data of dataResults) {
    if (data.preview) {
      results[data.index].firstUserMessage = data.preview.firstUserMessage;
      results[data.index].lastUserMessage = data.preview.lastUserMessage;
      results[data.index].messageCount = data.preview.messageCount;
      results[data.index].firstMessageTimestamp = data.preview.firstUserMessageTimestamp;
    }
    if (data.activity) {
      results[data.index].currentActivity = data.activity;
    }
    const mostRecentTimestamp = pickMostRecentTimestamp(
      data.sessionMtimeTimestamp || undefined,
      data.preview?.firstUserMessageTimestamp
    );
    if (mostRecentTimestamp) {
      results[data.index].lastActivityTimestamp = mostRecentTimestamp;
    }
    if (data.quickDetails) {
      results[data.index].quickSummary = data.quickDetails.summary;
      results[data.index].recentFiles = data.quickDetails.recentFiles;
      results[data.index].recentFileTimes = data.quickDetails.recentFileTimes;
      results[data.index].recentTools = data.quickDetails.recentTools;
      results[data.index].recentToolCalls = data.quickDetails.recentToolCalls;
      results[data.index].recentEvents = data.quickDetails.recentEvents;
      results[data.index].attachments = data.quickDetails.attachments;
      results[data.index].lastFilePath = data.quickDetails.lastFilePath;
      results[data.index].narrative = data.quickDetails.narrative;
    }
    results[data.index].waitingForInput = data.waitingForInput;

    const currentStatus = results[data.index].approvalStatus;
    const currentActivity = results[data.index].currentActivity;
    if (currentActivity) {
      // The CLI now-line is set only while the session is actively working.
      results[data.index].approvalStatus = 'running';
      results[data.index].status = 'running';
    } else if (results[data.index].sessionId && currentStatus === 'pending') {
      results[data.index].approvalStatus = 'approved';
      results[data.index].status = 'idle';
    }
  }

  // All terminals are at the same level - no automatic hierarchy
  // Set status based on activity
  for (const result of results) {
    if (!result.approvalStatus) {
      result.approvalStatus = result.currentActivity ? 'running' : 'pending';
    }
    if (!result.status) {
      result.status = result.currentActivity ? 'running' : 'idle';
    }
  }

  // The CLI session stream already supplies cwd and branch. The extension does
  // not run a parallel git status implementation to decorate those records.
  if (workspacePath && results.length > 0) {
    for (const result of results) {
      result.cwd = workspacePath;
    }
  }

  results.sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < results.length; i++) {
    results[i].index = i + 1;
  }

  return results;
}

export async function getFloorTerminalDetails(workspacePath?: string): Promise<TerminalDetail[]> {
  const agentTypes = ['claude', 'codex', 'gemini', 'opencode', 'cursor'];
  const localDetails = (await Promise.all(
    agentTypes.map((agentType) => getTerminalsByAgentType(agentType, workspacePath)),
  )).flat();

  localDetails.sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < localDetails.length; i++) {
    localDetails[i].index = i + 1;
  }
  return localDetails;
}

// Clear state (for testing/deactivation)
export function clear(): void {
  // Dispose any auto-label pollers still running so deactivate doesn't leak
  // intervals for terminals whose label never resolved.
  for (const entry of editorTerminals.values()) {
    if (entry.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
      entry.autoLabelPollerId = undefined;
    }
  }
  editorTerminals.clear();
  terminalIdCounter = 0;
  sessionSummaryCache.clear();
}

// Session persistence for restore across VS Code restarts

// Build persisted session data from current terminals
export function buildPersistedSessions(): sessionsPersist.PersistedSession[] {
  const sessions: sessionsPersist.PersistedSession[] = [];

  for (const entry of editorTerminals.values()) {
    // Only persist agent terminals (not regular terminals)
    if (!entry.agentConfig) continue;

    sessions.push({
      terminalId: entry.id,
      prefix: entry.agentConfig.prefix,
      sessionId: entry.sessionId,
      host: entry.host,
      label: entry.label,
      autoLabel: entry.autoLabel,
      agentType: entry.agentType,
      version: entry.version,
      createdAt: entry.createdAt,
      agentPid: entry.pid,
    });
  }

  return sessions;
}

// Persist all current sessions for a workspace
export function persistSessions(workspacePath: string): void {
  const sessions = buildPersistedSessions();
  sessionsPersist.saveWorkspaceSessions(workspacePath, sessions, true);
}

// Load persisted sessions for a workspace
export function loadPersistedSessions(workspacePath: string): sessionsPersist.PersistedSession[] {
  return sessionsPersist.getWorkspaceSessions(workspacePath);
}

// Clear persisted sessions after successful restore
export function clearPersistedSessions(workspacePath: string): void {
  sessionsPersist.clearWorkspaceSessions(workspacePath);
}

// Update a session's metadata (e.g., when CLI sessionId is captured)
export function updatePersistedSession(
  workspacePath: string,
  terminalId: string,
  updates: Partial<sessionsPersist.PersistedSession>
): void {
  sessionsPersist.updateSession(workspacePath, terminalId, updates);
}
