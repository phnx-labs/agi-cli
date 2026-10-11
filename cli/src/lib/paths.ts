import * as path from 'path';

export function isSafeSegmentName(name: string): boolean {
  return (
    !!name &&
    name !== '.' && name !== '..' &&
    !/[\/\\\x00]/.test(name) &&
    name.length <= 255
  );
}

export function safeJoin(base: string, name: string): string {

  if (!isSafeSegmentName(name)) {
    throw new Error(`Invalid name: ${name}`);
  }
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(`Path escape: ${name}`);
  return resolved;
}

export function assertWithin(root: string, target: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escape: ${target}`);
  }
  return resolved;
}
