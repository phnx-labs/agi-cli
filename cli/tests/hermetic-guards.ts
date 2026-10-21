import * as os from 'node:os';

export function shouldEnableCiTestProfile(env: NodeJS.ProcessEnv): boolean {

  return env.CI === 'true' || env.AGENTS_ATTEST_PRODUCER === '1';
}

export function shouldArmHermeticGuards(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI) && env.AGENTS_ATTEST_PRODUCER !== '1';
}

// macOS os.tmpdir() is /var/folders/…/T/, too long for the ssh ControlPath under the sandbox home.
export function sandboxTmpRoot(): string {
  return process.platform === 'darwin' ? '/tmp' : os.tmpdir();
}
