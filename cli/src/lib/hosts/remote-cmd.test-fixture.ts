/**
 * Test-only decoder for a rendered remote PowerShell command.
 *
 * `renderPowershellCommand` emits whichever of two representations is shorter: the
 * plain `-EncodedCommand <base64 UTF-16LE>`, or a `-Command` bootstrap carrying a
 * deflated UTF-8 payload. Tests assert on the SCRIPT, not the representation, so
 * every suite needs both — and four copies of that parsing is exactly how one of
 * them silently stops decoding the form it was meant to check.
 *
 * Named `*.test-fixture.ts` after the existing `daemon.test-fixture.ts`.
 */
import * as zlib from 'node:zlib';

/** The script behind either render route. Throws if the command is neither. */
export function decodeRenderedPowershell(command: string): string {
  const encoded = /-EncodedCommand (\S+)\s*$/.exec(command);
  if (encoded) return Buffer.from(encoded[1]!, 'base64').toString('utf16le');
  const packed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(command);
  if (!packed) throw new Error(`not a rendered PowerShell command: ${command}`);
  return zlib.inflateRawSync(Buffer.from(packed[1]!, 'base64')).toString('utf-8');
}
