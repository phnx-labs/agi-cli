
import * as path from 'path';
import { getHistoryDir } from './state.js';
import { machineId } from './machine-id.js';

let _localMachineId: string | undefined;

export function localMachineId(): string {
  return (_localMachineId ??= machineId());
}

export function machineForSessionFile(filePath: string, agent: string): string {


  if (!filePath) return localMachineId();
  const base = path.join(getHistoryDir(), 'backups', agent) + path.sep;
  if (filePath.startsWith(base)) {
    const seg = filePath.slice(base.length).split(path.sep)[0];
    if (seg) return seg;
  }
  return localMachineId();
}
