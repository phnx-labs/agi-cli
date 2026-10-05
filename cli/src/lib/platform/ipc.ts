/**
 * Local-daemon IPC endpoint, platform-aware.
 */
import * as crypto from 'crypto';

/** Resolves the address a local daemon listens on: the AF_UNIX path on POSIX; on Windows a named
 * pipe (`\\.\pipe\agents-<hash>`) named from a hash of the socket path so both sides agree without
 * disk. Never probe it with fs.existsSync (always false). */
export function ipcEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const hash = crypto.createHash('sha1').update(socketPath).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\agents-${hash}`;
  }
  return socketPath;
}
