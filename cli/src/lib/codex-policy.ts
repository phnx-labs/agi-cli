import * as fs from 'fs';
import { getUserAgentsDir } from './state.js';
import { codexDefaultWritableRoots } from './permissions.js';
import { repoAgentsDirForCwd } from './project-key.js';

type CodexPolicyMode = 'plan' | 'edit' | 'auto' | 'skip';

export const CODEX_PLAN_PROFILE = 'agents-plan';
export const CODEX_EDIT_PROFILE = 'agents-edit';
export const CODEX_AUTO_PROFILE = 'agents-auto';

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Writable roots for Codex's `edit` profile: the managed `.agents` dir, toolchain caches, and the
 * repo's `.agents` when cwd is in a repo. That last lets builds write `.agents/worktrees/`:
 * `workspace-write` hardcodes `.agents/` read-only and only an explicit root overrides it. */
export function codexEditWritableRoots(cwd?: string): string[] {
  const repoAgents = repoAgentsDirForCwd(cwd);
  // Only widen the sandbox for a `.agents` that actually exists — most repos
  // have none, and there is no point naming a directory that isn't there. (Codex
  // tolerates a missing writable root, so this is tidiness, not a hard guard.)
  const repoRoots = repoAgents && fs.existsSync(repoAgents) ? [repoAgents] : [];
  return unique([getUserAgentsDir(), ...codexDefaultWritableRoots(), ...repoRoots]);
}

function inlineWorkspaceRoots(roots: string[]): string {
  return roots.map((root) => `${JSON.stringify(root)} = true`).join(', ');
}

export function codexPermissionProfileConfig(
  mode: Exclude<CodexPolicyMode, 'skip'>,
  writableRoots: string[] = codexEditWritableRoots(),
): string {
  const parent = mode === 'plan' ? ':read-only' : ':workspace';
  const roots = mode === 'plan'
    ? ''
    : `, workspace_roots = { ${inlineWorkspaceRoots(unique(writableRoots))} }`;
  return `{ extends = ${JSON.stringify(parent)}${roots}, network = { enabled = true, allow_local_binding = true } }`;
}

const CODEX_PROFILES: Record<Exclude<CodexPolicyMode, 'skip'>, string> = {
  plan: CODEX_PLAN_PROFILE,
  edit: CODEX_EDIT_PROFILE,
  auto: CODEX_AUTO_PROFILE,
};

/** Canonical Codex safety policy for every native launch via config overrides: only named
 * permission profiles keep a plan run read-only while enabling network. `auto` and `edit` share
 * one sandbox and differ in `approval_policy`: `edit` is `on-request`; `auto` is `never`. */
export function codexPolicyArgs(
  mode: CodexPolicyMode,
  writableRoots: string[] = codexEditWritableRoots(),
): string[] {
  if (mode === 'skip') return ['--dangerously-bypass-approvals-and-sandbox'];

  const profile = CODEX_PROFILES[mode];
  return [
    '-c',
    `approval_policy=${mode === 'auto' ? '"never"' : '"on-request"'}`,
    '-c',
    `default_permissions=${JSON.stringify(profile)}`,
    '-c',
    `permissions.${profile}=${codexPermissionProfileConfig(mode, writableRoots)}`,
  ];
}

/** Preserve whether --mode was omitted when a run is re-dispatched remotely. */
export function modeForRemoteDispatch(
  mode: string,
  source: string | undefined,
): string | undefined {
  return source === 'default' ? undefined : mode;
}

/** Only the untouched Commander default selects Codex's writable default. */
export function modeWasImplicit(
  source: string | undefined,
  hasConfiguredDefault: boolean,
): boolean {
  return source === 'default' && !hasConfiguredDefault;
}
