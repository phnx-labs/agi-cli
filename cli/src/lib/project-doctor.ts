/** Definition-vs-reality checks for `agents projects`. A hand-edited def's `repo:` said
 * `<user>/agents-cli` while origin was `phnx-labs/agents-cli`; both real, so the card silently
 * reported a stranger's repo. Findings carry their own fix; pure. */

import type { ProjectDef } from './projects.js';

/** A definition that disagrees with the machine it describes. */
interface ProjectFinding {
  project: string;
  /** One line naming the disagreement, both sides quoted. */
  message: string;
  /** The exact command that fixes it. */
  remediation: string;
}

/** Compare a def's `repo` slug with the checkout's `origin`. Unreadable remote: no finding. No
 * `repo` in the def: a finding only if a remote exists to adopt. Disagreement: a finding, the
 * silently-lying case. */
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
