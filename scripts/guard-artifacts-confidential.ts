#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface GuardOptions {
  base?: string;
  head?: string;
  repoRoot: string;
}

export interface Violation {
  file: string;
  reason: 'filename' | 'content';
  detail: string;
}

const ARTIFACTS_PREFIX = '.agents/artifacts/';
const PRIVATE_PREFIX = '.agents/artifacts/private/';

const FILENAME_SIGNALS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bgtm\b/, label: 'go-to-market / GTM' },
  { pattern: /monetiz/, label: 'monetization' },
  { pattern: /pricing-model/, label: 'pricing model' },
  { pattern: /\brevenue\b/, label: 'revenue' },
  { pattern: /launch-venue/, label: 'launch venue' },
  { pattern: /stars-playbook/, label: 'GitHub stars playbook' },
  { pattern: /\bcompetitor\b/, label: 'competitor' },
  { pattern: /go-to-market/, label: 'go-to-market' },
  { pattern: /\barr\b/, label: 'ARR' },
  { pattern: /\bmrr\b/, label: 'MRR' },
  { pattern: /\bchurn\b/, label: 'churn' },
];

const EXPLICIT_CONTENT_SIGNALS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bmonetization\b/i, label: 'monetization' },
  { pattern: /\bgtm\b/i, label: 'GTM' },
  { pattern: /\bpricing\s+tier\b/i, label: 'pricing tier' },
  { pattern: /\bgo-to-market\b/i, label: 'go-to-market' },
  { pattern: /\bcompetitor\s+(?:intel|intelligence)\b/i, label: 'competitor intelligence' },
  { pattern: /\bcompetitive\s+(?:intel|intelligence)\b/i, label: 'competitive intelligence' },
  { pattern: /\blaunch\s+venue\b/i, label: 'launch venue' },
  { pattern: /\bstars\s+playbook\b/i, label: 'stars playbook' },
  { pattern: /\bhow-winners-charge\b/i, label: 'pricing strategy' },
];

const STRATEGY_CONTEXT_RES: RegExp[] = [
  /\brevenue\b/i,
  /\barr\b/i,
  /\bmrr\b/i,
  /\bchurn\b/i,
  /\bpricing\b/i,
  /\bmonetization\b/i,
  /\bgtm\b/i,
  /\bgo-to-market\b/i,
  /\bcompetitor\b/i,
  /\bcompetitive\b/i,
  /\bcompetition\b/i,
  /\blaunch\s+venue\b/i,
  /\bstars\s+playbook\b/i,
];

const DOLLAR_FIGURE_RE = /\$\d[\d,]*\.?\d*\s*[KMBkmb]?/;

export function posix(file: string): string {
  return file.split(sep).join('/');
}

export function repoRootFrom(cwd = process.cwd()): string {
  const proc = Bun.spawnSync({
    cmd: ['git', 'rev-parse', '--show-toplevel'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return cwd;
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

function gitDiffNameStatus(base: string, head: string, cwd: string): string[] {
  const proc = Bun.spawnSync({
    cmd: ['git', 'diff', '--name-status', '--find-renames', `${base}...${head}`],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8').trim());
  }
  const lines = Buffer.from(proc.stdout).toString('utf8').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0]![0]!;
    if (status === 'D') continue;
    const path = parts[parts.length - 1];
    if (path) out.push(posix(path));
  }
  return out;
}

export function readChangedFilesFromStdin(): string[] {
  const input = readFileSync(0);
  const separator = input.includes(0) ? '\0' : '\n';
  return input.toString('utf8').split(separator).filter(Boolean);
}

export function isUnderPublicArtifacts(file: string): boolean {
  const f = posix(file);
  return f.startsWith(ARTIFACTS_PREFIX) && !f.startsWith(PRIVATE_PREFIX);
}

export function checkFilename(file: string): string | null {
  const base = posix(file).split('/').pop()?.toLowerCase() ?? '';
  for (const { pattern, label } of FILENAME_SIGNALS) {
    if (pattern.test(base)) {
      return `filename matches sensitive signal: ${label}`;
    }
  }
  return null;
}

function hasStrategyContext(text: string): boolean {
  return STRATEGY_CONTEXT_RES.some((re) => re.test(text));
}

export function checkContent(text: string): string | null {
  for (const { pattern, label } of EXPLICIT_CONTENT_SIGNALS) {
    const match = pattern.exec(text);
    if (match) {
      const snippet = text.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20)
        .replace(/\s+/g, ' ').trim();
      return `content contains ${label}: "${snippet}"`;
    }
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (DOLLAR_FIGURE_RE.test(line) && hasStrategyContext(line)) {
      const snippet = line.replace(/\s+/g, ' ').trim();
      return `content couples strategy language with a dollar figure: "${snippet}"`;
    }
  }

  return null;
}

export function inspectFile(repoRoot: string, file: string): Violation | null {
  if (!isUnderPublicArtifacts(file)) return null;

  const filenameHit = checkFilename(file);
  if (filenameHit) {
    return { file, reason: 'filename', detail: filenameHit };
  }

  const abs = join(repoRoot, file);
  if (!existsSync(abs)) return null;
  const text = readFileSync(abs, 'utf8');
  const contentHit = checkContent(text);
  if (contentHit) {
    return { file, reason: 'content', detail: contentHit };
  }

  return null;
}

export function inspectFiles(repoRoot: string, files: readonly string[]): Violation[] {
  return files.map((f) => inspectFile(repoRoot, f)).filter((v): v is Violation => v !== null);
}

export function changedArtifactFiles(options: GuardOptions): string[] {
  const files = options.base && options.head
    ? gitDiffNameStatus(options.base, options.head, options.repoRoot)
    : readChangedFilesFromStdin();
  return files.filter(isUnderPublicArtifacts);
}

const ERROR_LEAD = `\nCONFIDENTIAL-CONTENT GUARD FAILED (PHNX-3033)

The following file(s) under the PUBLIC \`.agents/artifacts/\` tree look like confidential
GTM, monetization, pricing, revenue, or competitor strategy material. Everything committed
to \`.agents/artifacts/<yyyy-mm-dd>/\` is public by design; it must not contain strategy
intel, financial figures, or launch planning.
`;

const ERROR_TAIL = `
Move these files to the gitignored \`.agents/artifacts/private/\` directory, or keep them
in a private repo. See the "The \`.agents/\` workspace" section of AGENTS.md / CLAUDE.md.
`;

export function formatError(violations: Violation[]): string {
  const lines = violations.map((v) => {
    const rel = v.file;
    return `  - ${rel}\n    ${v.detail}`;
  });
  return `${ERROR_LEAD}\n${lines.join('\n\n')}\n${ERROR_TAIL}`;
}

function parseArgs(argv: string[]): GuardOptions & { help: boolean } {
  const out: GuardOptions & { help: boolean } = {
    repoRoot: repoRootFrom(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base': out.base = argv[++i]; break;
      case '--head': out.head = argv[++i]; break;
      case '--repo-root': out.repoRoot = argv[++i]; break;
      case '--help': out.help = true; break;
    }
  }
  if ((out.base && !out.head) || (!out.base && out.head)) {
    throw new Error('--base and --head must be supplied together');
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      `usage: bun scripts/guard-artifacts-confidential.ts [--base <sha>] [--head <sha>]\n\n`
      + `Fails if added/modified files under .agents/artifacts/ (excluding private/)\n`
      + `match confidential-strategy filename or content signals.\n`
      + `With no --base/--head, reads file paths from stdin.\n`,
    );
    return;
  }

  const files = changedArtifactFiles(args);
  if (files.length === 0) {
    process.stdout.write('no public artifact changes to guard\n');
    return;
  }

  const violations = inspectFiles(args.repoRoot, files);
  if (violations.length === 0) {
    process.stdout.write(`guarded ${files.length} public artifact file(s): clean\n`);
    return;
  }

  process.stderr.write(formatError(violations));
  process.exit(1);
}

if (import.meta.main) {
  main();
}
