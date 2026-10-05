import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-test-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { execShimPassthrough } = await import('./exec.js');

describe('execShimPassthrough', () => {
  it('returns 127 without spawning when the agent has no installed default', async () => {
    const code = await execShimPassthrough('claude', [], TEST_HOME);
    expect(code).toBe(127);
  });
});
