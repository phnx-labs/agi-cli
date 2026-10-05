import { AGENTS } from '../agents.js';
import { getGlobalDefault } from './versions.js';
import type { AgentId } from '../types.js';
import { listInstallations } from './store.js';
import type { Installation } from './types.js';

/** Addressing a frozen installation. A selector matches the stable label or the release it
 * currently carries (they differ after an update). Matching both makes same-release duplicates
 * addressable; ambiguity is reported, not resolved to whichever sorted first. */

export class InstallationNotFoundError extends Error {
  constructor(
    public readonly agent: AgentId,
    public readonly selector: string | undefined,
    public readonly available: readonly Installation[]
  ) {
    // Nothing installed is a different problem from "your selector missed", and
    // the remedy differs — say which one it is rather than printing an empty list.
    super(
      available.length === 0
        ? `No ${AGENTS[agent].name} installations are managed by agents-cli. Install one with: agents add ${agent}`
        : `No ${AGENTS[agent].name} installation matches '${selector}'. Installed: ${available.map((i) => describeInstallation(i)).join(', ')}`
    );
    this.name = 'InstallationNotFoundError';
  }
}

export class InstallationAmbiguousError extends Error {
  constructor(
    public readonly agent: AgentId,
    public readonly selector: string | undefined,
    public readonly candidates: readonly Installation[]
  ) {
    super(
      `'${selector ?? agent}' matches ${candidates.length} ${AGENTS[agent].name} installations `
      + `(${candidates.map((i) => describeInstallation(i)).join(', ')}). `
      + `Select one by its installation label.`
    );
    this.name = 'InstallationAmbiguousError';
  }
}

/** `2.0.65` when frozen at its original release, `2.0.65 (release 2.0.71)` after an update. */
export function describeInstallation(installation: Installation): string {
  return installation.releaseVersion === installation.label
    ? installation.label
    : `${installation.label} (release ${installation.releaseVersion})`;
}

export interface ResolveInstallationOptions {
  /** An `agents accounts` label; narrows to the installation currently signed into that account
   * before the selector is applied. */
  account?: string;
}

/** Resolve `<agent>[@<selector>]` to exactly one installation: with no selector, the pinned
 * default, else the sole installation. Never a "newest wins" guess, which is how an update
 * lands on the wrong install. */
export async function resolveInstallation(
  agent: AgentId,
  selector: string | undefined,
  options: ResolveInstallationOptions = {}
): Promise<Installation> {
  const all = listInstallations(agent);
  if (all.length === 0) throw new InstallationNotFoundError(agent, selector, all);

  let candidates = all;
  if (options.account) {
    throw new Error("--account no longer selects an installation. Account names are durable credentials used by 'agents run --account'; select the installation by its label instead.");
  }

  if (selector) {
    const byLabel = candidates.filter((i) => i.label === selector);
    // A label is unique by construction (it is a directory name), so a label hit
    // is decisive and never competes with a release hit on another installation.
    if (byLabel.length === 1) return byLabel[0];
    const byRelease = candidates.filter((i) => i.releaseVersion === selector);
    if (byRelease.length === 1) return byRelease[0];
    if (byRelease.length > 1) throw new InstallationAmbiguousError(agent, selector, byRelease);
    throw new InstallationNotFoundError(agent, selector, all);
  }

  if (candidates.length === 1) return candidates[0];

  const defaultLabel = getGlobalDefault(agent);
  const pinned = defaultLabel ? candidates.find((i) => i.label === defaultLabel) : undefined;
  if (pinned) return pinned;

  throw new InstallationAmbiguousError(agent, selector, candidates);
}
