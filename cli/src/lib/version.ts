import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cached: string | null = null;

function readVersionAt(pkgPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return String(pkg.version || '') || null;
  } catch {
    return null;
  }
}

export function resolveAgentsBin(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'agents'),
    '/opt/homebrew/bin/agents',
    '/usr/local/bin/agents',
    path.join(home, '.npm-global', 'bin', 'agents'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
    }
  }
  return null;
}

interface InstallLayout {
  distDir: string;
  entryPath: string;
  pkgJsonPath: string;
}

export function installLayoutFromBin(realBin: string): InstallLayout {
  const distDir = path.dirname(path.dirname(realBin));
  return {
    distDir,
    entryPath: path.join(distDir, 'index.js'),
    pkgJsonPath: path.join(distDir, '..', 'package.json'),
  };
}

export function resolveInstalledLayout(): InstallLayout | null {
  const bin = resolveAgentsBin();
  if (!bin) return null;
  try {
    const layout = installLayoutFromBin(fs.realpathSync(bin));
    if (fs.existsSync(layout.entryPath)) return layout;
  } catch {
  }
  return null;
}

export function getCliVersion(
  pkgJsonPath: string = path.join(__dirname, '..', '..', 'package.json')
): string {
  if (cached) return cached;
  cached = readVersionAt(pkgJsonPath) ?? readInstalledPackageVersion() ?? 'unknown';
  return cached;
}

function readInstalledPackageVersion(): string | null {
  const layout = resolveInstalledLayout();
  return layout ? readVersionAt(layout.pkgJsonPath) : null;
}

export function getCliVersionFresh(
  pkgJsonPath: string = path.join(__dirname, '..', '..', 'package.json')
): string {
  return readVersionAt(pkgJsonPath) ?? readInstalledPackageVersion() ?? 'unknown';
}
