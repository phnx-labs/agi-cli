import * as crypto from 'crypto';

export function ipcEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const hash = crypto.createHash('sha1').update(socketPath).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\agents-${hash}`;
  }
  return socketPath;
}
