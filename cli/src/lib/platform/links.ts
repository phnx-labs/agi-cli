import * as fs from 'fs';

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
