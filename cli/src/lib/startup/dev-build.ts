import * as fs from 'fs';
import * as path from 'path';

/** Detect a source-checkout dev build (suppresses autopull, migrations, auto-update): a
 * `0.0.0-dev*` stamp or an agents-cli git checkout. Realpath argv[1] and check the package name
 * first (/opt/homebrew is a git repo); `.git` is searched only DEV_BUILD_GIT_ANCESTOR_DEPTH up. */
const DEV_BUILD_GIT_ANCESTOR_DEPTH = 2;
/** Whether a version string is the `0.0.0-dev.<sha>[-dirty]` stamp `scripts/install.sh` writes for
 * dev installs (`install.sh:61`). Split out because a caller with only a version string (a fleet
 * rollout reading a remote `--version`) cannot do the filesystem check. */
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
