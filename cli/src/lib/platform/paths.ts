import * as os from 'os';
import * as path from 'path';

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

export function looksLikePath(query: string, platform: NodeJS.Platform = process.platform): boolean {
  if (
    query === '.' ||
    query.startsWith('./') ||
    query.startsWith('../') ||
    query.startsWith('/') ||
    query.startsWith('~')
  ) {
    return true;
  }
  if (platform === 'win32') {
    return (
      WIN_DRIVE_RE.test(query) ||
      query.startsWith('\\\\') ||
      query.startsWith('.\\') ||
      query.startsWith('..\\')
    );
  }
  return false;
}

export function toComparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return p.replace(/\\/g, '/').toLowerCase();
  return p;
}

export function homeDir(): string {
  return os.homedir();
}

export function isWindowsAbsolutePath(p: string): boolean {
  return WIN_DRIVE_RE.test(p) || p.startsWith('\\\\');
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function toNativePath(p: string, sep: string = path.sep): string {
  return sep === '/' ? p : p.replace(/\//g, sep);
}

export function toPortableKey(p: string): string {
  return p.replace(/^([a-zA-Z]):/, '$1').replace(/[\\/ ]/g, '_');
}
