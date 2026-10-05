import * as zlib from 'node:zlib';

export function decodeRenderedPowershell(command: string): string {
  const encoded = /-EncodedCommand (\S+)\s*$/.exec(command);
  if (encoded) return Buffer.from(encoded[1]!, 'base64').toString('utf16le');
  const packed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(command);
  if (!packed) throw new Error(`not a rendered PowerShell command: ${command}`);
  return zlib.inflateRawSync(Buffer.from(packed[1]!, 'base64')).toString('utf-8');
}
