/** Platform abstraction: the ONE place OS-divergent behavior is decided. Consumers state intent
 * (looksLikePath, findExecutable, isAlive) instead of checking `process.platform`. Helpers take an
 * explicit `platform` (default process.platform) so all three OSes are unit-testable on any host. */
export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export * from './paths.js';
export * from './exec.js';
export * from './links.js';
export * from './process.js';
export * from './ipc.js';
export * from './winpath.js';
