
import {
  listInstalledVersions,
  getGlobalDefault,
  getIsolatedDefault,
  getProjectVersion,
  isVersionInstalled,
} from '../installations/store.js';
import type { VersionProvider } from './types.js';

export const defaultVersionProvider: VersionProvider = {
  listInstalled: (agent) => listInstalledVersions(agent),
  getProjectVersion: (agent, cwd) => getProjectVersion(agent, cwd),
  getGlobalDefault: (agent) => getGlobalDefault(agent),
  getIsolatedDefault: (agent) => getIsolatedDefault(agent),
  isInstalled: (agent, version) => isVersionInstalled(agent, version),
};
