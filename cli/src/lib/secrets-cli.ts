
import { findInPath } from './agent-spec/agents.js';

export const SECRETS_CLI_NAME = 'secrets';
export const SECRETS_CLI_PACKAGE = '@phnx-labs/secrets-cli';

export const SECRETS_CLI_VERSION = '0.3.0';
export const SECRETS_CLI_SPEC = `${SECRETS_CLI_PACKAGE}@${SECRETS_CLI_VERSION}`;
export const SECRETS_CLI_INSTALL_HINT = `npm i -g ${SECRETS_CLI_SPEC}`;


export function isSecretsPresent(): boolean {
  const explicit = process.env.SECRETS_BIN?.trim();
  if (explicit) return true;
  return findInPath(SECRETS_CLI_NAME) !== null;
}
