import * as os from 'os';
import * as path from 'path';

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/** Does this positional argument look like a path (vs a search term)? POSIX markers (`.`, `./`,
 * `../`, `/`, `~`) apply on every platform; Windows shapes (`C:\`, UNC, `.\`) only on win32, so
 * `C:\repo` typed on macOS/Linux stays a search term. */
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

/** Normalizes a path for comparison: on Windows backslashes become forward slashes and the path is
 * lowercased (case-insensitive FS); on POSIX the input is returned unchanged. */
export function toComparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return p.replace(/\\/g, '/').toLowerCase();
  return p;
}

/** Canonical home directory. Use this instead of `process.env.HOME`, which is unset on Windows
 * (`USERPROFILE`); `os.homedir()` works on all three platforms. */
export function homeDir(): string {
  return os.homedir();
}

/** Is this a Windows absolute path: a drive-letter root (`C:\`, `C:/`) or a UNC share? Used by
 * local-source parsing to catch native Windows paths the POSIX prefixes miss; the caller decides
 * whether to apply it (typically gated on win32). */
export function isWindowsAbsolutePath(p: string): boolean {
  return WIN_DRIVE_RE.test(p) || p.startsWith('\\\\');
}

/** Folds backslashes to forward slashes, for a path going into a string that must read the same on
 * every OS (display path, regex subject, forward-slash-keyed lookup). Pure; POSIX input is
 * unchanged. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Folds forward slashes to the native separator, the inverse of {@link toPosix}: for paths from
 * sources that emit POSIX separators everywhere (`git rev-parse` prints `C:/Users/...` on Windows)
 * so they compare equal to `path.*` paths. Unchanged on POSIX. */
export function toNativePath(p: string, sep: string = path.sep): string {
  return sep === '/' ? p : p.replace(/\//g, sep);
}

/** Derives a filesystem-safe key from an absolute path: drops the Windows drive colon and folds
 * separators and spaces to `_` (POSIX `/a/b c` gives `_a_b_c`, Windows `C:\a\b` gives `C_a_b`).
 * Shell mirror, keep byte-identical: `printf '%s' "$P" | tr -d ':' | tr '\\/ ' '_'`. */
export function toPortableKey(p: string): string {
  return p.replace(/^([a-zA-Z]):/, '$1').replace(/[\\/ ]/g, '_');
}
