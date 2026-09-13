/**
 * Definition-vs-reality checks for `agents projects`.
 *
 * A project definition is hand-editable YAML that nothing validates against the
 * world it describes, so it can drift into being confidently wrong. The one that
 * bit for real: `repo:` said `<user>/agents-cli` while the checkout's `origin`
 * was `phnx-labs/agents-cli`. Both are real repositories, so nothing errored —
 * the card's merged-PR and release lines simply reported a stranger's repo (0
 * merges in 7 days instead of 100). A wrong answer that looks like a right one
 * is worse than a missing one, so the mismatch gets said out loud wherever the
 * def is shown.
 *
 * Findings carry their own fix, mirroring `DoctorFinding.remediation`
 * (`lib/devices/doctor-findings.ts`) — a warning the reader has to go work out
 * how to act on is half a warning. Pure: the caller supplies the observed
 * remote, so this is unit-testable with no git and no fixture repo.
 */

import type { ProjectDef } from './projects.js';

/** A definition that disagrees with the machine it describes. */
interface ProjectFinding {
  project: string;
  /** One line naming the disagreement, both sides quoted. */
  message: string;
  /** The exact command that fixes it. */
  remediation: string;
}

/**
 * Compare a def's `repo` slug against the checkout's real `origin` remote.
 *
 * - remote unreadable (no checkout on this machine, not a git repo) → no
 *   finding. The def may be perfectly right; this machine just can't say.
 * - def has no `repo` → a finding only when a remote exists to adopt, so the
 *   fix is a real one-liner rather than a nag.
 * - they disagree → a finding. This is the case that silently lies.
 */
export function checkRepoSlug(def: ProjectDef, actualRemote: string | undefined): ProjectFinding | undefined {
  if (!actualRemote) return undefined;
  if (def.repo === actualRemote) return undefined;
  const fix = `agents projects set ${def.name} --repo ${actualRemote}`;
  if (!def.repo) {
    return {
      project: def.name,
      message: `no repo set; origin is ${actualRemote}`,
      remediation: fix,
    };
  }
  return {
    project: def.name,
    message: `repo is ${def.repo} but origin is ${actualRemote} — PR and release counts are being read from the wrong repository`,
    remediation: fix,
  };
}
