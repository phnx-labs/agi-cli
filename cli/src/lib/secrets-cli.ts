/**
 * The standalone `secrets` CLI that agents-cli talks to (PHNX-3989).
 *
 * The engine lives in `@phnx-labs/secrets-cli`. This module is the pin and the
 * presence check used by setup / doctor / host-CLI install — it carries no
 * storage. Presence is `findInPath`, which skips `~/.agents/.cache/shims`: a
 * leftover alias there `exec`s `agents secrets` and would recurse (agi-cli#3532).
 *
 * Keep this file free of `cli-resources` imports: `secrets-client.ts` loads it,
 * and a cycle through the host-CLI parser would pull yaml/spawn into the
 * process-client module graph.
 */
import { findInPath } from './agent-spec/agents.js';

export const SECRETS_CLI_NAME = 'secrets';
export const SECRETS_CLI_PACKAGE = '@phnx-labs/secrets-cli';
/** Published standalone the setup/doctor/clis path installs; bump with the protocol. */
export const SECRETS_CLI_VERSION = '0.1.2';
export const SECRETS_CLI_SPEC = `${SECRETS_CLI_PACKAGE}@${SECRETS_CLI_VERSION}`;
export const SECRETS_CLI_INSTALL_HINT = `npm i -g ${SECRETS_CLI_SPEC}`;

/**
 * True when `$SECRETS_BIN` is set or a real `secrets` executable is on PATH
 * outside agents-cli's shims dir. Does not spawn the binary.
 */
export function isSecretsPresent(): boolean {
  const explicit = process.env.SECRETS_BIN?.trim();
  if (explicit) return true;
  return findInPath(SECRETS_CLI_NAME) !== null;
}
