/**
 * Routine execution context + readiness resolution.
 *
 * A scheduled routine has to run *somewhere*. This module is the single,
 * target-aware answer to "which directory does this routine's run land in, and
 * is the chosen harness able to start there?" — computed for the eventual
 * execution TARGET, never from the daemon process's own cwd.
 *
 * Two layers, both pure of global state (every input is injected, so a test
 * exercises the real code path against real temp directories rather than a mock):
 *
 *  - {@link resolveRoutineExecutionContext} — resolve the working directory from
 *    the routine's singular `project` anchor and/or portable `cwd`, following the
 *    locked resolution table (see below), and verify the structural + filesystem
 *    readiness of that directory (existence, portability, writability, cloud
 *    portability). This layer owns the *context* readiness codes.
 *  - {@link evaluateRoutineReadiness} — take a resolved context and layer the
 *    *harness/target* readiness codes (agent installed, Codex workspace trust,
 *    live auth, target reachability) via injected probes.
 *
 * Resolution table (target `$HOME` = the execution device's home):
 *
 *  | project | cwd            | resolved dir            | readiness |
 *  |---------|----------------|-------------------------|-----------|
 *  | usable  | —              | project base            | continue  |
 *  | usable  | relative       | base + cwd (inside base)| continue if inside base + exists |
 *  | rootless| relative       | $HOME + cwd             | continue if exists |
 *  | —       | relative       | $HOME + cwd             | continue if exists |
 *  | —       | ~/…            | $HOME-relative          | continue if exists |
 *  | —       | abs under home | normalized to ~/…       | continue  |
 *  | —       | abs outside home| local-pinned only      | pause (cwd_not_portable) for host/fleet/cloud |
 *  | named+unusable | —       | no fallback             | pause (project_path_missing) |
 *  | —       | — (agent/workflow) | no implicit home     | pause (execution_context_missing) |
 *  | —       | — (command)    | $HOME                   | continue (housekeeping) |
 */

import * as path from 'path';

/** Stable, machine-readable readiness codes. A routine is activated only when ready. */
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
  /** Human-readable one-line explanation of the failing check. */
  message: string;
  /** A single safe command that repairs the blocker, when one exists. */
  repair?: string;
}

/** Where the routine body executes — mirrors {@link HostStrategy} placement. */
export type PlacementMode = 'local' | 'host' | 'fleet' | 'cloud';

/**
 * What the caller resolved about the routine's singular `project` anchor.
 * `undefined` (the field on the input) means the routine names no project.
 */
export type ProjectResolution =
  | { defined: false }
  /** Defined project; `base` is its portable base dir (`~/…` or absolute), or
   *  undefined for a rootless Linear-imported project with no checkout. */
  | { defined: true; base?: string };

export type RoutineKind = 'agent' | 'workflow' | 'command';

/** A filesystem probe against the execution TARGET. */
export interface ContextFsProbe {
  exists(absPath: string): boolean;
  isDirectory(absPath: string): boolean;
  isWritable(absPath: string): boolean;
}

export interface ExecutionContextInput {
  /** Routine name (for messages only). */
  name?: string;
  /** Singular execution anchor (`JobConfig.project`). */
  project?: string;
  /** Portable execution directory (`JobConfig.cwd`). */
  cwd?: string;
  /** Exactly one of agent/workflow/command determines the fallback rules. */
  kind: RoutineKind;
  /** Placement of the run — governs portability enforcement and cloud rules. */
  mode: PlacementMode;
  /** Execution target's absolute `$HOME`. Local: `os.homedir()`; remote: the target home. */
  targetHome: string;
  /** Resolution of the `project` anchor; omit when the routine names no project. */
  projectResolution?: ProjectResolution;
  /**
   * Filesystem probe for the target, present only when this process can inspect
   * it (a local run, or add/edit/doctor invoked on the target box). Absent for a
   * remote/cloud target we cannot reach — then only structural + portability
   * checks run (existence is deferred, never assumed).
   */
  probe?: ContextFsProbe;
}

export interface ResolvedExecutionContext {
  project?: string;
  /** `config.cwd` echoed for the run record. */
  requestedCwd?: string;
  /** Portable resolved cwd for the run record: `~/…` when under target home, else absolute. */
  resolvedCwd?: string;
  /** The resolved cwd expanded to an absolute path on the target. Undefined when unresolved. */
  absoluteCwd?: string;
  targetHome: string;
  ready: boolean;
  /** Present when `ready` is false. */
  readiness?: RoutineReadiness;
}

// --- target-aware path helpers (do NOT use project-root.ts's local-HOME-bound
// forms: resolution must root at the execution target's home, not this box's) ---

/**
 * Path flavour of the EXECUTION TARGET, inferred from its own home string.
 *
 * The target home belongs to whichever machine will run the routine, which need
 * not be this one — a Windows box can schedule onto a Linux target. Joining with
 * the LOCAL separator therefore built `\home\user\svc` for a POSIX target (and
 * would build `C:/Users/x/svc` the other way), so these helpers key off the home
 * path's shape instead of `process.platform`. Same-platform behaviour is
 * unchanged; only the cross-platform case is fixed.
 */
function targetPath(home: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(home) || home.includes('\\') ? path.win32 : path.posix;
}

/** Expand a leading `~`/`$HOME` against the target home; pass other values through. */
function expandTargetHome(home: string, p: string): string {
  if (p === '~' || p === '$HOME') return home;
  const tp = targetPath(home);
  if (p.startsWith('~/')) return tp.join(home, p.slice(2));
  if (p.startsWith('$HOME/')) return tp.join(home, p.slice('$HOME/'.length));
  return p;
}

/** Rewrite an absolute path under the target home to its portable `~/…` form; pass others through. */
function toTargetPortable(home: string, abs: string): string {
  const tp = targetPath(home);
  const rel = tp.relative(home, abs);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !tp.isAbsolute(rel)) return '~/' + rel.split(tp.sep).join('/');
  return abs;
}

/**
 * True for a bare relative path (not absolute, not home-anchored) ON THE TARGET.
 *
 * `isAbsolute` is evaluated in the TARGET's own path flavour (see
 * {@link targetPath}), not this process's platform — a Windows-shaped absolute
 * cwd (`C:\Users\x\override`) dispatched from a POSIX daemon must still be
 * recognized as absolute, or it is misread as project-relative.
 */
export function isBareRelative(home: string, p: string): boolean {
  return !targetPath(home).isAbsolute(p) && !p.startsWith('~') && !p.startsWith('$HOME');
}

/**
 * True when `child` is `base` or strictly beneath it (no `..` escape).
 *
 * Compares in the BASE's own path flavour (see {@link targetPath}) — both
 * arguments are target-side paths, and comparing a POSIX pair with Windows
 * semantics (or the reverse) answers about the wrong filesystem.
 */
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

/**
 * Resolve the working directory a routine's run lands in and verify its
 * structural + filesystem readiness for the given placement. Pure of global
 * state — every dependency (target home, project resolution, filesystem probe)
 * is injected.
 */
export function resolveRoutineExecutionContext(input: ExecutionContextInput): ResolvedExecutionContext {
  const { project, cwd, kind, mode, targetHome, projectResolution, probe } = input;
  const requestedCwd = cwd;
  const base = { project, requestedCwd, targetHome };
  const hasProjectBinding = projectResolution?.defined === true;

  // Finalize a resolved portable dir: run the cloud/portability/filesystem gates
  // and return either a ready context or a paused one.
  const finalize = (portable: string, missingCode: RoutineReadinessCode): ResolvedExecutionContext => {
    const absoluteCwd = expandTargetHome(targetHome, portable);
    const ctx = { ...base, resolvedCwd: portable, absoluteCwd };

    // Cloud: a filesystem-only cwd (no project/repo binding) has no provider
    // repository to map onto. A project binding selects the provider repo.
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

  // 1. Explicit project anchor.
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
      // Usable base path.
      if (cwd === undefined) {
        return finalize(projBase, 'project_path_missing');
      }
      if (isBareRelative(targetHome, cwd)) {
        const baseAbs = expandTargetHome(targetHome, projBase);
        // Target-side join: `path.resolve` would use this host's separator and,
        // for a target home this host does not consider absolute, prepend the
        // local process cwd.
        const joinedAbs = targetPath(targetHome).resolve(baseAbs, cwd);
        if (!isInside(baseAbs, joinedAbs)) {
          return pause(base, {
            code: 'cwd_not_portable',
            message: `cwd '${cwd}' escapes the project base '${projBase}' — a project-relative cwd must stay inside it`,
          });
        }
        return finalize(toTargetPortable(targetHome, joinedAbs), 'cwd_missing');
      }
      // Absolute or home-anchored cwd alongside a project: fall through to the
      // cwd-first handling below (the project base is not the anchor then).
    } else if (cwd === undefined) {
      // Rootless project (Linear import), no cwd: there is nothing to run in.
      return pause(base, {
        code: 'project_path_missing',
        message: `project '${project}' has no checkout path — give it a cwd (anchored at the target home) or set the project's root`,
        repair: `agents routines edit ${input.name ?? '<name>'} --cwd <path>`,
      });
    }
    // Rootless project + a cwd, or usable project + a non-relative cwd: the cwd
    // itself is the anchor. A bare relative cwd anchors at the target home.
  }

  // 2. cwd without a (usable relative-anchoring) project.
  if (cwd !== undefined) {
    if (cwd.startsWith('~') || cwd.startsWith('$HOME')) {
      const abs = expandTargetHome(targetHome, cwd);
      return finalize(toTargetPortable(targetHome, abs), 'cwd_missing');
    }
    // Absolute in EITHER path flavour — a Windows daemon resolving a POSIX
    // target cwd (or the reverse) must not fall through to bare-relative join.
    // Do not `path.resolve` on the local platform: on win32 that rewrites
    // `/home/u/override` to `D:\home\u\override` and falsely flags
    // cwd_not_portable (Windows CI, cross-platform schedule).
    const cwdIsAbsolute =
      targetPath(targetHome).isAbsolute(cwd) ||
      path.posix.isAbsolute(cwd) ||
      path.win32.isAbsolute(cwd);
    if (cwdIsAbsolute) {
      const resolved = cwd;
      if (isInside(targetHome, resolved)) {
        // Normalize an absolute-under-home path to its portable form on save.
        return finalize(toTargetPortable(targetHome, resolved), 'cwd_missing');
      }
      // Absolute path outside the target home: only a local-pinned routine can
      // use it; host/fleet/cloud placement cannot carry a non-portable path.
      if (mode === 'local') {
        return finalize(resolved, 'cwd_missing');
      }
      return pause(base, {
        code: 'cwd_not_portable',
        message: `absolute cwd '${cwd}' is outside the target home and cannot travel to ${mode} placement — use a home-relative path`,
      });
    }
    // Bare relative cwd (no usable project base): anchor at the target home,
    // in the target's own path flavour (see the joinedAbs note above).
    return finalize(toTargetPortable(targetHome, targetPath(targetHome).resolve(targetHome, cwd)), 'cwd_missing');
  }

  // 3. Neither field.
  if (kind === 'command') {
    // Command routines are deterministic housekeeping — the target home is a
    // safe implicit cwd, so a version-check / notify routine keeps working.
    return finalize(toTargetPortable(targetHome, targetHome), 'cwd_missing');
  }
  return pause(base, {
    code: 'execution_context_missing',
    message: `routine '${input.name ?? ''}' has no project or cwd — an agent/workflow routine needs an explicit execution directory`,
    repair: `agents routines edit ${input.name ?? '<name>'} --project-anchor <name>  # or --cwd <path>`,
  });
}

// --- harness/target readiness layering ---

/** Injected harness/target probes for {@link evaluateRoutineReadiness}. */
interface HarnessReadinessProbes {
  /** Is the resolved agent+version installed on the target? */
  agentInstalled?(): boolean;
  /** Is the absolute execution dir a trusted Codex workspace? (Codex agent only.) */
  codexTrusted?(absoluteCwd: string): boolean;
  /** Live auth verdict for the resolved account/version. `ok:false` → agent_auth_failed. */
  authOk?(): { ok: boolean; reason?: string };
  /** Is the execution target reachable? (host/fleet/cloud placement only.) */
  targetReachable?(): boolean;
}

export interface RoutineReadinessResult {
  context: ResolvedExecutionContext;
  ready: boolean;
  readiness?: RoutineReadiness;
}

/**
 * Layer the harness/target readiness codes onto a resolved execution context.
 * Context blockers short-circuit (no point probing auth for a routine that has
 * no directory to run in). Every probe is optional and injected; an omitted
 * probe is treated as "not applicable / passes" so a caller only pays for the
 * checks it wires up.
 */
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
    // A pinned version names its exact miss — "no usable version" would send the
    // operator hunting for a harness that IS installed, just not at the pin.
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
