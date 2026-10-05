import * as fs from 'fs';
import * as path from 'path';

const DEV_BUILD_GIT_ANCESTOR_DEPTH = 2;
export function isDevVersionStamp(version: string): boolean {
  return version.startsWith('0.0.0-dev');
}

export function detectDevBuild(argv1: string, version: string): boolean {
  // Realpath + exact package identity + bounded ancestry avoids classifying nested installs as dev.
  if (isDevVersionStamp(version)) return true;
  try {
    const cliPath = fs.realpathSync(argv1 || '');
    const packageRoot = path.dirname(path.dirname(cliPath));
    const pkgPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const name = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))?.name;
    if (name !== '@phnx-labs/agents-cli') return false;

    let dir = packageRoot;
    for (let depth = 0; depth <= DEV_BUILD_GIT_ANCESTOR_DEPTH; depth++) {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}
