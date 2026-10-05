/** Filesystem linking, platform-aware. Windows symlinks need Administrator or Developer Mode while
 * directory *junctions* don't, so `createLink` uses a junction for directories and falls back to a
 * copy for file links when the OS refuses the symlink. */
import * as fs from 'fs';

/** Create a link at `dst` to `src`. Directory: Windows junction, else symlink. File: symlink, copy
 * fallback on Windows EPERM/ENOSYS (a snapshot). `dst` must not exist; the copy is non-atomic, so
 * callers link to a temp name and rename. */
export function createLink(src: string, dst: string): void {
  const win = process.platform === 'win32';
  const isDir = fs.statSync(src).isDirectory();
  const type: fs.symlink.Type | undefined = win ? (isDir ? 'junction' : 'file') : undefined;
  try {
    fs.symlinkSync(src, dst, type);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (win && !isDir && (code === 'EPERM' || code === 'ENOSYS')) {
      fs.copyFileSync(src, dst);
      return;
    }
    throw err;
  }
}
