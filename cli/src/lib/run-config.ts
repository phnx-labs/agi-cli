/** Project-local `run:` config discovery: user/system `agents.yaml` is read via state.ts, while
 * project-local agents.yaml files are discovered from the cwd upward. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { RunConfig } from './types.js';
import { getUserAgentsDir } from './state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return project-local run configs from nearest directory upward. */
export function getProjectRunConfigs(startPath: string = process.cwd()): RunConfig[] {
  const configs: RunConfig[] = [];
  let dir = path.resolve(startPath);
  const userAgentsYaml = path.join(getUserAgentsDir(), 'agents.yaml');

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, 'agents.yaml');
    if (manifestPath !== userAgentsYaml && fs.existsSync(manifestPath)) {
      try {
        const parsed = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (isRecord(parsed?.run)) {
          configs.push(parsed.run as RunConfig);
        }
      } catch {
        // Ignore malformed project config and keep walking.
      }
    }
    dir = path.dirname(dir);
  }

  return configs;
}
