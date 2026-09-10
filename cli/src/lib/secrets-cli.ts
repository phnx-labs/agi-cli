/**
 * The standalone `secrets` CLI that agents-cli talks to (PHNX-3989).
 *
 * The engine lives in `@phnx-labs/secrets-cli`. This module is the pin and the
 * presence check used by setup / doctor / host-CLI install — it carries no
 * storage. Presence is `findInPath`, which skips `~/.agents/.cache/shims`: a
 * leftover alias there `exec`s `agents secrets` and would recurse (agi-cli#3532).
 */
import { findInPath } from './agent-spec/agents.js';
import type { CliManifest } from './cli-resources.js';

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

/**
 * Fallback host-CLI manifest used when no `clis/secrets.yaml` is declared in
 * project/user/system layers. `agents clis install secrets` and doctor listing
 * then still have a method: the same pinned npm package.
 */
export function builtinSecretsCliManifest(): CliManifest {
  return {
    name: SECRETS_CLI_NAME,
    description: 'Standalone secrets CLI — keychain-backed bundles for agents-cli',
    homepage: 'https://github.com/phnx-labs/secrets-cli',
    check: { kind: 'which', cmd: SECRETS_CLI_NAME },
    install: [{ npm: SECRETS_CLI_SPEC }],
    postInstall: [
      'Then onboard existing stores:',
      '  agents setup secrets',
      '  agents secrets list',
    ].join('\n'),
    source: 'builtin',
    path: '(builtin)',
  };
}
