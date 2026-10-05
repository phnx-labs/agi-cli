import * as fs from 'fs';
import * as path from 'path';

/** Canonicalizes `target` by `realpath`-resolving its longest EXISTING ancestor and re-appending
 * the not-yet-created tail. Plain `realpathSync` throws on a missing target, yet a symlink in the
 * existing part is the escape containment checks must resolve. */
export function realpathExistingPrefix(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // nothing on this path exists
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `name` is a safe single path segment: non-empty, not '.'/'..', no path separators or
 * null bytes, within the filename length limit. Dot-prefixed names like '.env.example' are
 * allowed. */
export function isSafeSegmentName(name: string): boolean {
  return (
    !!name &&
    name !== '.' && name !== '..' &&
    !/[\/\\\x00]/.test(name) &&
    name.length <= 255
  );
}

/** Resolves base + name while preventing path traversal: rejects separators, null bytes, '.' and
 * '..', and any resolved path escaping the base. Dot-prefixed names are allowed (traversal is
 * caught by the containment check); spaces and unicode are fine. */
export function safeJoin(base: string, name: string): string {
  if (!isSafeSegmentName(name)) {
    throw new Error(`Invalid name: ${name}`);
  }
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(`Path escape: ${name}`);
  return resolved;
}

/** Asserts `target` (which may contain separators, e.g. a multi-segment relative key) stays within
 * `root` after normalization. For untrusted nested relative paths; `safeJoin` is stricter (single
 * segments). */
export function assertWithin(root: string, target: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escape: ${target}`);
  }
  return resolved;
}
