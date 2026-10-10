#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import pkg from 'ssh2';

const { Server } = pkg;

const mode = process.env.SRP_MODE;
if (mode !== 'old-peer' && mode !== 'malformed' && mode !== 'current') {
  throw new Error(`SRP_MODE must be 'old-peer', 'malformed' or 'current', got ${JSON.stringify(mode)}`);
}
const hostKey = fs.readFileSync(process.env.SRP_HOST_KEY);
const peerHome = process.env.SRP_PEER_HOME;
const username = process.env.SRP_USERNAME;
const expectedCommand = process.env.SRP_EXPECTED_COMMAND;
const proofFile = process.env.SRP_PROOF_FILE;
if (!username || !expectedCommand || !proofFile) {
  throw new Error('SRP_USERNAME, SRP_EXPECTED_COMMAND, and SRP_PROOF_FILE are required');
}

const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resolver-ssh-shim-'));
const shimBin = path.join(shimDir, 'agents');
if (mode === 'old-peer') {
  const oldStub = path.join(path.dirname(new URL(import.meta.url).pathname), 'old-agents-cli-stub.mjs');
  fs.writeFileSync(
    shimBin,
    `#!/bin/sh\nexec ${process.execPath} '${oldStub}' "$@"\n`,
  );
} else {
  fs.writeFileSync(
    shimBin,
    `#!/bin/sh\nexec ${process.execPath} --import '${process.env.SRP_TSX_LOADER}' '${process.env.SRP_CLI_ENTRY}' "$@"\n`,
  );
}
fs.chmodSync(shimBin, 0o755);

fs.writeFileSync(
  path.join(peerHome, '.bash_profile'),
  `export PATH="${shimDir}:$PATH"\n`,
);

const FORWARDED_ISOLATION_VARS = [
  'AGENTS_DEVICES_DIR',
  'AGENTS_STATE_DIR',
  'AGENTS_SECRETS_AGENT_DIR',
  'AGENTS_SECRETS_NO_AGENT',
  'AGENTS_NO_USAGE_TRACK',
  'AGENTS_EVENTS_PATH',
  'AGENTS_HOOK_SHIMS_DIR',
  'AGENTS_HOOK_CACHE_DIR',
  'AGENTS_LOGS_DIR',
  'AGENTS_PERF_DIR',
  'AGENTS_REAL_HOME',
];

function runExecCommand(command) {
  return new Promise((resolve) => {
    const inherited = process.env;
    const forwarded = {};
    for (const key of FORWARDED_ISOLATION_VARS) {
      if (inherited[key] !== undefined) forwarded[key] = inherited[key];
    }
    const child = spawn('bash', ['-c', command], {
      cwd: peerHome,
      env: {
        HOME: peerHome,
        USERPROFILE: peerHome,
        PATH: `${shimDir}${path.delimiter}${inherited.PATH || ''}`,
        NODE_NO_WARNINGS: '1',
        AGENTS_SKIP_MIGRATION: '1',
        ...forwarded,
        ...(inherited.HTTP_PROXY ? { HTTP_PROXY: inherited.HTTP_PROXY } : {}),
        ...(inherited.HTTPS_PROXY ? { HTTPS_PROXY: inherited.HTTPS_PROXY } : {}),
        ...(inherited.NO_PROXY ? { NO_PROXY: inherited.NO_PROXY } : {}),
        ...(inherited.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: inherited.NODE_EXTRA_CA_CERTS } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'none' && ctx.username === username) ctx.accept();
    else ctx.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, _reject, info) => {
        const stream = accept();
        if (info.command !== expectedCommand) {
          stream.stderr.write('fixture: rejected unexpected command');
          stream.exit(126);
          stream.end();
          return;
        }
        runExecCommand(info.command).then(({ code, stdout, stderr }) => {
          if (mode === 'old-peer') {
            const expectedError = "unknown option '--resolve-safe-v1'";
            if (code !== 1 || !stderr.includes(expectedError)) {
              stream.stderr.write(`fixture: old CLI did not reject the protocol as expected (code=${code}): ${stderr}`);
              stream.exit(98);
              stream.end();
              return;
            }
            fs.writeFileSync(proofFile, `${process.env.SRP_OLD_VERSION}:${expectedError}\n`);
            stream.write(stdout);
            stream.exit(code);
            stream.end();
          } else if (mode === 'current') {
            fs.writeFileSync(proofFile, stdout);
            stream.write(stdout);
            stream.stderr.write(stderr);
            stream.exit(code);
            stream.end();
          } else {
            if (code !== 0) {
              stream.stderr.write(`fixture: current CLI did not exit 0 (code=${code}): ${stdout}${stderr}`);
              stream.exit(97);
              stream.end();
              return;
            }
            stream.write('{not-json');
            stream.exit(0);
            stream.end();
          }
        });
      });
    });
  });
  client.on('close', () => {
    fs.rmSync(shimDir, { recursive: true, force: true });
    server.close();
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
});
