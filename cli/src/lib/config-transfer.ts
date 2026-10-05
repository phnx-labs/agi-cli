import * as fs from 'fs';
import * as path from 'path';

export function moveDirCrossDevice(source: string, dest: string): void {
  // On EXDEV, remove the only source copy only after recursive copy succeeds.
  try {
    fs.renameSync(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(source, dest, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

export function copyDirStrippingAgentsSymlinks(source: string, dest: string, agentsDir: string): void {
  // Exports omit managed links into ~/.agents so they cannot become dangling/private references.
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
