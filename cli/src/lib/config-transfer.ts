import * as fs from 'fs';
import * as path from 'path';

export function moveDirCrossDevice(source: string, dest: string): void {

  try {
    fs.renameSync(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(source, dest, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

export function copyDirStrippingAgentsSymlinks(source: string, dest: string, agentsDir: string): void {

  const inside = agentsDir + path.sep;
  fs.cpSync(source, dest, {
    recursive: true,
    force: true,
    filter: (src) => {
      try {
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) {
          const tgt = path.resolve(path.dirname(src), fs.readlinkSync(src));
          if (tgt === agentsDir || tgt.startsWith(inside)) return false;
        }
      } catch {
      }
      return true;
    },
  });
}
