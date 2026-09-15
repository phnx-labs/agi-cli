import { describe } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Shared fixture for the sessions.*.test.ts suite slices (RUSH-2819).
 *
 * sessions.test.ts was one 2,600-line file measured at 172s — the single
 * slowest file in CI, serializing an entire fork while every other selected
 * file finished. The suite is split into topical slices so vitest's per-file
 * fork parallelism can spread the subprocess-heavy tests across workers; the
 * helpers each slice shares live here.
 */

// win32: Claude projects path joins absolute cwd with colons (RUSH-2215).
export const describeLive: typeof describe.skip = process.platform === 'win32' ? describe.skip : describe;

export const repoRoot = process.cwd();
export const cliEntry = path.join(repoRoot, 'src', 'index.ts');
// Run the CLI as `node --import <tsx loader> src/index.ts`: spawning `node`
// (always on PATH, no .cmd shell launcher) with the tsx ESM loader resolved to
// an absolute file URL keeps tsx loadable regardless of the spawn cwd (which we
// point at the project dir). Avoids both the Windows `tsx.cmd`-needs-a-shell
// problem and shell:true arg-concatenation (which would split multi-word query
// args like "prompt text").
export const tsxLoaderUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export function writeUpdateCache(tempHome: string): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')
  ) as { version: string };

  fs.mkdirSync(path.join(tempHome, '.agents', '.cache'), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, '.agents', '.cache', '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: packageJson.version }),
    'utf-8'
  );
  // ensureInitialized() checks for ~/.agents/.system/.git to confirm setup.
  fs.mkdirSync(path.join(tempHome, '.agents', '.system', '.git'), { recursive: true });
}

export function writeClaudeSession(
  tempHome: string,
  projectKey: string,
  sessionId: string,
  cwd: string,
  content: string,
  timestamp: string,
): void {
  fs.mkdirSync(cwd, { recursive: true });
  const sessionsDir = path.join(tempHome, '.claude', 'projects', projectKey);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      timestamp,
      cwd,
      sessionId,
      version: '2.1.110',
      gitBranch: 'main',
      message: { role: 'user', content },
    }) + '\n',
    'utf-8'
  );
}

export function writeCodexSession(
  tempHome: string,
  sessionId: string,
  cwd: string,
  prompt: string,
  timestamp: string,
): void {
  fs.mkdirSync(cwd, { recursive: true });
  const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '04', '17');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const filePath = path.join(
    sessionsDir,
    `rollout-${timestamp.replace(/[:.]/g, '-')}-${sessionId}.jsonl`
  );

  const lines = [
    JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp,
        cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.113.0',
        source: 'cli',
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions>\nFilesystem sandboxing.\n</permissions instructions>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp/project</cwd>\n  <shell>zsh</shell>\n</environment_context>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<collaboration_mode># Collaboration Mode: Default\n</collaboration_mode>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nDo work.\n</INSTRUCTIONS>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Looking into it now.' }],
      },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

export function writeOpenClawSetup(tempHome: string, version = '2026.3.8'): string {
  const managedHome = path.join(tempHome, '.agents', '.history', 'versions', 'openclaw', version, 'home', '.openclaw');
  fs.mkdirSync(managedHome, { recursive: true });

  const activeHome = path.join(tempHome, '.openclaw');
  fs.mkdirSync(path.dirname(activeHome), { recursive: true });
  if (!fs.existsSync(activeHome)) {
    fs.symlinkSync(managedHome, activeHome);
  }

  const managedWorkspace = path.join(managedHome, 'sergey');
  fs.mkdirSync(managedWorkspace, { recursive: true });
  fs.writeFileSync(
    path.join(managedHome, 'openclaw.json'),
    JSON.stringify({
      agents: {
        list: [
          { id: 'sergey', workspace: path.join(activeHome, 'sergey') },
        ],
      },
    }, null, 2),
    'utf-8'
  );

  const binDir = path.join(tempHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const openclawBin = path.join(binDir, 'openclaw');
  fs.writeFileSync(
    openclawBin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "openclaw/${version}"
  exit 0
fi

if [ "$1" = "channels" ] && [ "$2" = "status" ]; then
  echo "- Telegram sergey (Sergey): enabled, configured, running, out:2h ago, mode:polling, token:config"
  exit 0
fi

if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  echo "ID NAME SCHEDULE NEXT LAST STATUS TARGET AGENT MODEL"
  echo "12345678-1234-1234-1234-123456789abc sergey-hourly  cron */30 * * * * in 7h  48m ago  ok  isolated  sergey  -"
  exit 0
fi

exit 1
`,
    'utf-8'
  );
  fs.chmodSync(openclawBin, 0o755);

  return path.join(activeHome, 'sergey');
}

export function runAgents(args: string[], cwd: string, home: string, envOverrides: Record<string, string> = {}) {
  return spawnSync('node', ['--import', tsxLoaderUrl, cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      // os.homedir() (used via homeDir() in discovery) reads USERPROFILE on
      // Windows and ignores HOME, so set both to redirect the home to tempHome.
      USERPROFILE: home,
      PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
      // Some fixtures place files at $HOME/.agents/versions/<agent>/<ver>/ as
      // legacy / synthetic state. The bootstrap-time migration would otherwise
      // move those into ~/.agents-system/, breaking workspace-scoped lookups.
      AGENTS_SKIP_MIGRATION: '1',
      NODE_NO_WARNINGS: '1',
      ...envOverrides,
    },
    encoding: 'utf-8',
  });
}

export function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}
