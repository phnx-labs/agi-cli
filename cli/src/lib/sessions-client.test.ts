import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getShimsDir } from './state.js';
import {
  SessionsClientError,
  _resetSessionsClientForTest,
  resolveSessionsBin,
} from './sessions-client.js';

describe('resolveSessionsBin', () => {
  describe.skipIf(process.platform === 'win32')(
    "never resolves to the legacy shim in agents-cli's own shims dir",
    () => {
      let realDir: string;
      let shimsDir: string;
      const prevPath = process.env.PATH;
      const prevBin = process.env.SESSIONS_BIN;

      beforeEach(() => {
        shimsDir = getShimsDir();
        fs.mkdirSync(shimsDir, { recursive: true });
        const shim = path.join(shimsDir, 'sessions');
        fs.writeFileSync(
          shim,
          `#!/bin/sh\nAGENTS_BIN='/opt/agents-cli/dist/index.js'\nexec "$AGENTS_BIN" sessions "$@"\n`,
        );
        fs.chmodSync(shim, 0o755);
        realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-real-bin-'));
        const real = path.join(realDir, 'sessions');
        fs.writeFileSync(real, '#!/bin/sh\necho standalone\n');
        fs.chmodSync(real, 0o755);
        delete process.env.SESSIONS_BIN;
        _resetSessionsClientForTest();
      });

      afterEach(() => {
        fs.rmSync(path.join(shimsDir, 'sessions'), { force: true });
        fs.rmSync(realDir, { recursive: true, force: true });
        process.env.PATH = prevPath;
        if (prevBin === undefined) delete process.env.SESSIONS_BIN;
        else process.env.SESSIONS_BIN = prevBin;
        _resetSessionsClientForTest();
      });

      it('uses the installed sessions-cli dependency and never the shim', () => {
        process.env.PATH = shimsDir;
        delete process.env.SESSIONS_BIN;
        _resetSessionsClientForTest();
        const bin = resolveSessionsBin();
        expect(bin.includes(`${path.sep}@phnx-labs${path.sep}sessions-cli${path.sep}`)).toBe(true);
        expect(fs.existsSync(bin)).toBe(true);
        expect(bin.startsWith(fs.realpathSync(shimsDir))).toBe(false);
      });

      it('a non-empty SESSIONS_BIN wins over the dependency and the shim', () => {
        process.env.SESSIONS_BIN = path.join(realDir, 'sessions');
        process.env.PATH = shimsDir;
        _resetSessionsClientForTest();
        expect(resolveSessionsBin()).toBe(path.join(realDir, 'sessions'));
      });

      it('an empty SESSIONS_BIN skips the dependency, then skips the shim for a PATH standalone', () => {
        process.env.SESSIONS_BIN = '';
        process.env.PATH = [shimsDir, realDir].join(path.delimiter);
        _resetSessionsClientForTest();
        expect(resolveSessionsBin()).toBe(fs.realpathSync(path.join(realDir, 'sessions')));
      });

      it('reports SESSIONS_BIN_MISSING when SESSIONS_BIN is empty and the shim is the only sessions on PATH', () => {
        process.env.SESSIONS_BIN = '';
        process.env.PATH = shimsDir;
        _resetSessionsClientForTest();
        try {
          resolveSessionsBin();
          throw new Error('expected resolveSessionsBin to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(SessionsClientError);
          expect((error as SessionsClientError).code).toBe('SESSIONS_BIN_MISSING');
        }
      });
    },
  );
});
