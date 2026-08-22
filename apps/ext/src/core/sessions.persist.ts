// Session persistence for terminal restore across VS Code restarts
// Stores session data in ~/.swarmify/agents/sessions.yaml

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import YAML from 'yaml';

const SWARMIFY_DIR = path.join(homedir(), '.swarmify');
const AGENTS_DATA_DIR = path.join(SWARMIFY_DIR, 'agents');
const SESSIONS_PATH = path.join(AGENTS_DATA_DIR, 'sessions.yaml');

// Persisted session data for a single terminal
export interface PersistedSession {
  terminalId: string;           // AGENT_TERMINAL_ID (e.g., "CL-1234567890-1")
  prefix: string;               // Agent prefix (e.g., "CL", "CX", "SH")
  sessionId?: string;           // CLI session ID for resume (e.g., Claude's session ID)
  host?: string;                // Device the agent was offloaded to (`agents run --host`); the
                                // transcript lives there, so a restored tab must keep routing
                                // its session lookups through that host.
  label?: string;               // User-set label
  autoLabel?: string;           // Harness/LLM-generated label; remains replaceable
  agentType?: string;           // Agent type key (e.g., "claude", "codex")
  version?: string;             // Pinned agent version, if known (e.g., "2.1.113")
  createdAt: number;            // Timestamp
  agentPid?: number;            // shell pid of the terminal (liveness cross-check)
}

// Per-workspace session data
interface WorkspaceSessionData {
  cleanShutdown: boolean;
  sessions: PersistedSession[];
}

// Root structure of sessions.yaml
interface SessionsFile {
  workspaces: Record<string, WorkspaceSessionData>;
}

// Ensure directory exists
function ensureDir(): void {
  fs.mkdirSync(AGENTS_DATA_DIR, { recursive: true });
}

// Load sessions file
function loadSessionsFile(): SessionsFile {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      const content = fs.readFileSync(SESSIONS_PATH, 'utf8');
      const data = YAML.parse(content);
      if (data && typeof data === 'object') {
        return {
          workspaces: data.workspaces || {}
        };
      }
    }
  } catch (err) {
    console.error('[SESSIONS] Failed to load sessions file:', err);
  }
  return { workspaces: {} };
}

// Save sessions file
function saveSessionsFile(data: SessionsFile): void {
  try {
    ensureDir();
    const content = YAML.stringify(data, { indent: 2 });
    fs.writeFileSync(SESSIONS_PATH, content);
  } catch (err) {
    console.error('[SESSIONS] Failed to save sessions file:', err);
  }
}

// Get sessions for a workspace
export function getWorkspaceSessions(workspacePath: string): PersistedSession[] {
  const data = loadSessionsFile();
  return data.workspaces[workspacePath]?.sessions || [];
}

// Save sessions for a workspace (called on deactivate)
export function saveWorkspaceSessions(
  workspacePath: string,
  sessions: PersistedSession[],
  cleanShutdown: boolean = true
): void {
  const data = loadSessionsFile();
  data.workspaces[workspacePath] = {
    cleanShutdown,
    sessions
  };
  saveSessionsFile(data);
  console.log(`[SESSIONS] Saved ${sessions.length} session(s) for ${workspacePath}`);
}

// Clear sessions for a workspace (called after successful restore)
export function clearWorkspaceSessions(workspacePath: string): void {
  const data = loadSessionsFile();
  if (data.workspaces[workspacePath]) {
    data.workspaces[workspacePath] = {
      cleanShutdown: true,
      sessions: []
    };
    saveSessionsFile(data);
  }
}

// Check if workspace had a clean shutdown
export function wasCleanShutdown(workspacePath: string): boolean {
  const data = loadSessionsFile();
  return data.workspaces[workspacePath]?.cleanShutdown ?? true;
}

// Mark workspace as not clean shutdown (called on activate before restore)
export function markDirtyShutdown(workspacePath: string): void {
  const data = loadSessionsFile();
  if (!data.workspaces[workspacePath]) {
    data.workspaces[workspacePath] = {
      cleanShutdown: false,
      sessions: []
    };
  } else {
    data.workspaces[workspacePath].cleanShutdown = false;
  }
  saveSessionsFile(data);
}

// Update a single session's metadata (e.g., when sessionId is captured)
export function updateSession(
  workspacePath: string,
  terminalId: string,
  updates: Partial<PersistedSession>
): void {
  const data = loadSessionsFile();
  const workspace = data.workspaces[workspacePath];
  if (!workspace) return;

  const session = workspace.sessions.find(s => s.terminalId === terminalId);
  if (session) {
    Object.assign(session, updates);
    saveSessionsFile(data);
  }
}
