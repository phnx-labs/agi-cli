export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export * from './paths.js';
export * from './exec.js';
export * from './links.js';
export * from './process.js';
export * from './ipc.js';
export * from './winpath.js';
