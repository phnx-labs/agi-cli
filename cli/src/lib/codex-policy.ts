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

/**
 * Writable roots for Codex's `edit` profile: the managed user `.agents` dir, the
 * baseline toolchain caches, and — when `cwd` is inside a repo — that repo's
 * `.agents` directory. The last entry is what lets an in-repo build write under
 * `.agents/worktrees/`; Codex's `workspace-write` sandbox hardcodes `.agents/`
 * read-only, and naming the directory as an explicit writable root is the only
 * thing that overrides it (a nested sub-path does not — bwrap refuses the mount).
 */
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

/**
 * Canonical Codex safety policy used by every native launch path.
 *
 * Config overrides are deliberately used instead of the legacy `--sandbox`
 * flags: named permission profiles are the only Codex surface that can keep a
 * plan run filesystem-read-only while independently enabling network access.
 *
 * `auto` and `edit` share one sandbox (`:workspace` plus the writable roots) and
 * differ only in `approval_policy`. `edit` is `on-request`: a command the sandbox
 * denies comes back as an approval prompt, which is right when someone is sitting
 * at the terminal. `auto` is `never`: nothing prompts, and a denied command
 * surfaces to the model as a plain command failure — the only behavior that works
 * for an unattended run, where a prompt nobody answers is an agent that has
 * stopped. Autonomy is the approval axis only; neither widens the sandbox, and
 * `skip` remains the sole mode that removes it.
 */
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
