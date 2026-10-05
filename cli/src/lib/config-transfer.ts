/** Primitives for moving an agent config directory across the agents-cli boundary, moved out of
 * uninstall.ts unchanged so other config-transfer paths don't import from a teardown-named module. */
import * as fs from 'fs';
import * as path from 'path';

/** Move `source` onto `dest` across volumes: `renameSync` throws EXDEV when `~/.agents` is on
 * another filesystem, so fall back to copy-then-remove, removing the source only after the copy
 * succeeds. */
export function moveDirCrossDevice(source: string, dest: string): void {
  try {
    fs.renameSync(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(source, dest, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

/** Copy `source` to `dest`, dropping symlinks that resolve into `~/.agents`: managed resources are
 * symlinked into version homes and would dangle once `~/.agents` is disposed. Gives a
 * self-contained export. */
export function copyDirStrippingAgentsSymlinks(source: string, dest: string, agentsDir: string): void {
  const inside = agentsDir + path.sep;
  fs.cpSync(source, dest, {
    recursive: true,
    // `force: true` is Node's default, but Bun drops it when a `filter` is supplied —
    // existing files are then silently left alone. `dist/bin/agents` is bun-compiled,
    // so this is a production path, not just a test artifact. State it explicitly.
    force: true,
    filter: (src) => {
      try {
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) {
          const tgt = path.resolve(path.dirname(src), fs.readlinkSync(src));
          if (tgt === agentsDir || tgt.startsWith(inside)) return false;
        }
      } catch {
        /* unreadable entry — let cpSync surface it on the real copy */
      }
      return true;
    },
  });
}
