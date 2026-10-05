
import * as path from 'path';

export type RoutineReadinessCode =
  | 'project_not_found'
  | 'project_path_missing'
  | 'cwd_missing'
  | 'cwd_not_directory'
  | 'cwd_not_portable'
  | 'execution_context_missing'
  | 'cloud_context_unsupported'
  | 'workspace_not_writable'
  | 'codex_workspace_untrusted'
  | 'agent_unavailable'
  | 'agent_auth_failed'
  | 'target_unreachable'
  | 'placement_unsupported'
  | 'migration_conflict';

export interface RoutineReadiness {
  code: RoutineReadinessCode;
  message: string;
  repair?: string;
}

export type PlacementMode = 'local' | 'host' | 'fleet' | 'cloud';

export type ProjectResolution =
  | { defined: false }
  | { defined: true; base?: string };

export type RoutineKind = 'agent' | 'workflow' | 'command';

export interface ContextFsProbe {
  exists(absPath: string): boolean;
  isDirectory(absPath: string): boolean;
  isWritable(absPath: string): boolean;
}

export interface ExecutionContextInput {
  name?: string;
  project?: string;
  cwd?: string;
  kind: RoutineKind;
  mode: PlacementMode;
  targetHome: string;
  projectResolution?: ProjectResolution;
  probe?: ContextFsProbe;
}

export interface ResolvedExecutionContext {
  project?: string;
  requestedCwd?: string;
  resolvedCwd?: string;
  absoluteCwd?: string;
  targetHome: string;
  ready: boolean;
  readiness?: RoutineReadiness;
}


function targetPath(home: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(home) || home.includes('\\') ? path.win32 : path.posix;
}

function expandTargetHome(home: string, p: string): string {
  if (p === '~' || p === '$HOME') return home;
  const tp = targetPath(home);
  if (p.startsWith('~/')) return tp.join(home, p.slice(2));
  if (p.startsWith('$HOME/')) return tp.join(home, p.slice('$HOME/'.length));
  return p;
}

function toTargetPortable(home: string, abs: string): string {
  const tp = targetPath(home);
  const rel = tp.relative(home, abs);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !tp.isAbsolute(rel)) return '~/' + rel.split(tp.sep).join('/');
  return abs;
}

export function isBareRelative(home: string, p: string): boolean {
  return !targetPath(home).isAbsolute(p) && !p.startsWith('~') && !p.startsWith('$HOME');
}

function isInside(baseAbs: string, childAbs: string): boolean {
  const tp = targetPath(baseAbs);
  const rel = tp.relative(baseAbs, childAbs);
  return rel === '' || (!rel.startsWith('..') && !tp.isAbsolute(rel));
}

function pause(
  ctx: { project?: string; requestedCwd?: string; resolvedCwd?: string; absoluteCwd?: string; targetHome: string },
  readiness: RoutineReadiness,
): ResolvedExecutionContext {
  return { ...ctx, ready: false, readiness };
}

export function resolveRoutineExecutionContext(input: ExecutionContextInput): ResolvedExecutionContext {
  const { project, cwd, kind, mode, targetHome, projectResolution, probe } = input;
  const requestedCwd = cwd;
  const base = { project, requestedCwd, targetHome };
  const hasProjectBinding = projectResolution?.defined === true;

  const finalize = (portable: string, missingCode: RoutineReadinessCode): ResolvedExecutionContext => {
    const absoluteCwd = expandTargetHome(targetHome, portable);
    const ctx = { ...base, resolvedCwd: portable, absoluteCwd };

    if (mode === 'cloud' && !hasProjectBinding) {
      return pause(ctx, {
        code: 'cloud_context_unsupported',
        message: `a bare cwd has no cloud repository to run in — bind a project/repo or run '${input.name ?? 'this routine'}' locally`,
        repair: `agents routines edit ${input.name ?? '<name>'} --project-anchor <name>`,
      });
    }

    if (probe) {
      if (!probe.exists(absoluteCwd)) {
        return pause(ctx, {
          code: missingCode,
          message: missingCode === 'project_path_missing'
            ? `project base directory does not exist on the target: ${portable}`
            : `execution directory does not exist on the target: ${portable}`,
          repair: `mkdir -p ${portable}`,
        });
      }
      if (!probe.isDirectory(absoluteCwd)) {
        return pause(ctx, {
          code: 'cwd_not_directory',
          message: `execution path is not a directory: ${portable}`,
        });
      }
      if (!probe.isWritable(absoluteCwd)) {
        return pause(ctx, {
          code: 'workspace_not_writable',
          message: `execution directory is not writable: ${portable}`,
        });
      }
    }

    return { ...ctx, ready: true };
  };

  if (project !== undefined) {
    if (!projectResolution || projectResolution.defined === false) {
      return pause(base, {
        code: 'project_not_found',
        message: `project '${project}' is not defined`,
        repair: `agents projects add ${project} --root <path>`,
      });
    }
    const projBase = projectResolution.base;
    if (projBase) {
      if (cwd === undefined) {
        return finalize(projBase, 'project_path_missing');
      }
      if (isBareRelative(targetHome, cwd)) {
        const baseAbs = expandTargetHome(targetHome, projBase);
        const joinedAbs = targetPath(targetHome).resolve(baseAbs, cwd);
        if (!isInside(baseAbs, joinedAbs)) {
          return pause(base, {
            code: 'cwd_not_portable',
            message: `cwd '${cwd}' escapes the project base '${projBase}' — a project-relative cwd must stay inside it`,
          });
        }
        return finalize(toTargetPortable(targetHome, joinedAbs), 'cwd_missing');
      }
    } else if (cwd === undefined) {
      return pause(base, {
        code: 'project_path_missing',
        message: `project '${project}' has no checkout path — give it a cwd (anchored at the target home) or set the project's root`,
        repair: `agents routines edit ${input.name ?? '<name>'} --cwd <path>`,
      });
    }
  }

  if (cwd !== undefined) {
    if (cwd.startsWith('~') || cwd.startsWith('$HOME')) {
      const abs = expandTargetHome(targetHome, cwd);
      return finalize(toTargetPortable(targetHome, abs), 'cwd_missing');
    }
    const cwdIsAbsolute =
      targetPath(targetHome).isAbsolute(cwd) ||
      path.posix.isAbsolute(cwd) ||
      path.win32.isAbsolute(cwd);
    if (cwdIsAbsolute) {
      const resolved = cwd;
      if (isInside(targetHome, resolved)) {
        return finalize(toTargetPortable(targetHome, resolved), 'cwd_missing');
      }
      if (mode === 'local') {
        return finalize(resolved, 'cwd_missing');
      }
      return pause(base, {
        code: 'cwd_not_portable',
        message: `absolute cwd '${cwd}' is outside the target home and cannot travel to ${mode} placement — use a home-relative path`,
      });
    }
    return finalize(toTargetPortable(targetHome, targetPath(targetHome).resolve(targetHome, cwd)), 'cwd_missing');
  }

  if (kind === 'command') {
    return finalize(toTargetPortable(targetHome, targetHome), 'cwd_missing');
  }
  return pause(base, {
    code: 'execution_context_missing',
    message: `routine '${input.name ?? ''}' has no project or cwd — an agent/workflow routine needs an explicit execution directory`,
    repair: `agents routines edit ${input.name ?? '<name>'} --project-anchor <name>  # or --cwd <path>`,
  });
}


interface HarnessReadinessProbes {
  agentInstalled?(): boolean;
  codexTrusted?(absoluteCwd: string): boolean;
  authOk?(): { ok: boolean; reason?: string };
  targetReachable?(): boolean;
}

export interface RoutineReadinessResult {
  context: ResolvedExecutionContext;
  ready: boolean;
  readiness?: RoutineReadiness;
}

export function evaluateRoutineReadiness(
  context: ResolvedExecutionContext,
  probes: HarnessReadinessProbes = {},
  opts: { agent?: string; version?: string } = {},
): RoutineReadinessResult {
  if (!context.ready) {
    return { context, ready: false, readiness: context.readiness };
  }

  if (probes.targetReachable && !probes.targetReachable()) {
    return withBlocker(context, {
      code: 'target_unreachable',
      message: 'the execution target is not reachable',
    });
  }

  if (probes.agentInstalled && !probes.agentInstalled()) {
    const pinned = opts.version && opts.agent ? `${opts.agent}@${opts.version}` : undefined;
    return withBlocker(context, {
      code: 'agent_unavailable',
      message: pinned
        ? `pinned ${pinned} is not installed on the target`
        : `no usable version of ${opts.agent ?? 'the agent'} is installed on the target`,
      repair: pinned ? `agents add ${pinned}` : (opts.agent ? `agents add ${opts.agent}@<version>` : undefined),
    });
  }

  if (probes.codexTrusted && context.absoluteCwd && !probes.codexTrusted(context.absoluteCwd)) {
    return withBlocker(context, {
      code: 'codex_workspace_untrusted',
      message: `Codex will not start in an untrusted workspace: ${context.resolvedCwd}`,
      repair: `trust the workspace (add it to Codex's trusted projects) — the routine never uses --skip-git-repo-check`,
    });
  }

  if (probes.authOk) {
    const verdict = probes.authOk();
    if (!verdict.ok) {
      return withBlocker(context, {
        code: 'agent_auth_failed',
        message: `the selected account failed a live auth check${verdict.reason ? `: ${verdict.reason}` : ''}`,
        repair: opts.agent ? `agents run ${opts.agent} -- login` : 'log the account back in',
      });
    }
  }

  return { context, ready: true };
}

function withBlocker(context: ResolvedExecutionContext, readiness: RoutineReadiness): RoutineReadinessResult {
  return { context: { ...context, ready: false, readiness }, ready: false, readiness };
}
