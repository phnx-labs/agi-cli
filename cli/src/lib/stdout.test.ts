import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('./stdout.ts', import.meta.url));

/** Run a child that writes `bytes` to a piped stdout through the helper, then exits at once. */
function readChildStdout(bytes: number): Promise<number> {
  const script = `
    const { writeStdoutFlushed } = await import(${JSON.stringify(helper)});
    await writeStdoutFlushed('x'.repeat(${bytes}));
    process.exit(0);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let received = 0;
    child.stdout.on('data', (chunk: Buffer) => { received += chunk.length; });
    child.on('error', reject);
    child.on('close', () => resolve(received));
  });
}

describe('writeStdoutFlushed', () => {
  it('delivers a reply larger than one pipe buffer before the process exits', async () => {
    // A fleet-state reply is ~200 KB; an unflushed write was cut at 65,536 bytes over ssh.
    expect(await readChildStdout(300_000)).toBe(300_000);
  }, 30_000);
});
