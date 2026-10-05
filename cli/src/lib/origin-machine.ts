/** Resolves which machine a session transcript came from: cross-machine sync mirrors remote ones to
 * `backups/<agent>/<machine>/<subdir>/...`, others are local. A leaf module (no session/db
 * imports) so discovery and the DB upsert can stamp `machine` without cycles. */

import * as path from 'path';
import { getHistoryDir } from './state.js';
import { machineId } from './machine-id.js';

let _localMachineId: string | undefined;

/** Local machine id, cached for the process lifetime. */
export function localMachineId(): string {
  return (_localMachineId ??= machineId());
}

/** The machine a discovered session originated on: the first path segment under the agent's backups
 * root, else the local machine. */
export function machineForSessionFile(filePath: string, agent: string): string {
  if (!filePath) return localMachineId();
  const base = path.join(getHistoryDir(), 'backups', agent) + path.sep;
  if (filePath.startsWith(base)) {
    const seg = filePath.slice(base.length).split(path.sep)[0];
    if (seg) return seg;
  }
  return localMachineId();
}
