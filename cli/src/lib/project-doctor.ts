
import type { ProjectDef } from './projects.js';

interface ProjectFinding {
  project: string;
  message: string;
  remediation: string;
}

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
