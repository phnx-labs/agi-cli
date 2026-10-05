/** The standalone `secrets` CLI agents-cli talks to (PHNX-3989): single pin and presence check for
 * `secrets-client.ts` and `agents setup secrets`, no storage. `findInPath` skips the shims dir (a
 * leftover alias would recurse). No `cli-resources` imports, to keep the client graph small. */
import { findInPath } from './agent-spec/agents.js';

export const SECRETS_CLI_NAME = 'secrets';
export const SECRETS_CLI_PACKAGE = '@phnx-labs/secrets-cli';
/** Published standalone `agents setup secrets` installs; bump with the protocol. */
export const SECRETS_CLI_VERSION = '0.1.8';
export const SECRETS_CLI_SPEC = `${SECRETS_CLI_PACKAGE}@${SECRETS_CLI_VERSION}`;
export const SECRETS_CLI_INSTALL_HINT = `npm i -g ${SECRETS_CLI_SPEC}`;

/** True when `$SECRETS_BIN` is set or a real `secrets` executable is on PATH outside agents-cli's
 * shims dir; does not spawn it. */
export function isSecretsPresent(): boolean {
  const explicit = process.env.SECRETS_BIN?.trim();
  if (explicit) return true;
  return findInPath(SECRETS_CLI_NAME) !== null;
}
