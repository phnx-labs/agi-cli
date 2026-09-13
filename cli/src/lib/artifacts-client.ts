// Thin client for the standalone `artifacts` CLI (`@phnx-labs/artifacts-cli`).
//
// The artifact render + share ENGINE lives in artifacts-cli, not this repo
// (PHNX-3992, mirroring the secrets/computer extractions). agents-cli calls it
// only where a `sessions` convenience wants to publish (`agents sessions share`).
// A missing executable fails loud with install guidance — there is no fallback
// to a retired in-repo engine.

import { findInPath } from './agent-spec/agents.js';

export const ARTIFACTS_INSTALL_HINT = 'npm i -g @phnx-labs/artifacts-cli';

export class ArtifactsClientError extends Error {
  constructor(
    readonly code: 'ARTIFACTS_BIN_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactsClientError';
  }
}

let cachedBin: string | null = null;

/**
 * Resolve the standalone `artifacts` executable. `ARTIFACTS_BIN` wins so a dev
 * build can be driven without touching PATH.
 *
 * Resolution uses `findInPath`, which skips `~/.agents/.cache/shims` — the same
 * load-bearing skip the secrets/computer clients rely on, so a leftover alias
 * shim that execs back into this CLI can never be picked as the engine.
 */
export function resolveArtifactsBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.ARTIFACTS_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? explicit : findInPath('artifacts');
  if (!resolved) {
    throw new ArtifactsClientError(
      'ARTIFACTS_BIN_MISSING',
      'The standalone `artifacts` CLI was not found. Install it with:\n' +
        `  ${ARTIFACTS_INSTALL_HINT}\n` +
        'or point $ARTIFACTS_BIN at its executable.',
    );
  }
  cachedBin = resolved;
  return resolved;
}

/** How to invoke the resolved binary: a `.js` entrypoint runs through this
 * runtime, a real executable is spawned directly. */
export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}
