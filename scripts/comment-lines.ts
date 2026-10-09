#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export const COMMENT_TARGET = 1700;

export type CommentKind = 'block' | 'doc' | 'hash' | 'line' | 'xml';

export interface CommentToken {
  start: number;
  end: number;
  kind: CommentKind;
  directive: boolean;
}

export interface FileComments {
  path: string;
  language: string;
  lines: number;
  directives: number;
  tokens: CommentToken[];
}

export interface CommentReport {
  schema: 'comment-lines-v1';
  total: number;
  target: number;
  remaining: number;
  directives: number;
  files: FileComments[];
}

interface Budget {
  schema: 'comment-budget-v1';
  target: number;
  ceiling: number;
}

type SlashMode = 'code' | 'double' | 'jsx-tag' | 'jsx-text' | 'regex' | 'single' | 'template';

const DIRECTIVE = /(?:@ts-|biome-ignore|cspell:|deno-lint-ignore|eslint-|istanbul ignore|noqa|prettier-ignore|shellcheck|type:\s*ignore|vite-ignore|webpackIgnore)/i;
const CODE_EXTENSIONS = new Map<string, string>([
  ['.bash', 'shell'],
  ['.cjs', 'javascript'],
  ['.css', 'css'],
  ['.html', 'html'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'javascript'],
  ['.plist', 'xml'],
  ['.py', 'python'],
  ['.scss', 'css'],
  ['.sh', 'shell'],
  ['.toml', 'toml'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.zsh', 'shell'],
]);
const IGNORED_EXTENSIONS = new Set([
  '.after', '.b64', '.before', '.err', '.gif', '.jpg', '.jpeg', '.json', '.jsonl',
  '.lock', '.log', '.md', '.mp3', '.mp4', '.ndjson', '.pdf', '.png', '.provisionprofile',
  '.stderr', '.stdout', '.svg', '.tsv', '.txt', '.webp',
]);
const IGNORED_BASENAMES = new Set([
  '.gitkeep', '.prettierrc', 'LICENSE', 'SHA256SUMS',
]);
const IGNORED_PREFIXES = ['.agents/', 'cli/docs/', 'cli/schema/'];
const GENERATED_BASENAMES = new Set(['HEALTH.html']);

let indexedSource = '';
let indexedLines: number[] = [];

function lineAt(source: string, offset: number): number {
  if (source !== indexedSource) {
    indexedSource = source;
    indexedLines = [0];
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) indexedLines.push(i + 1);
  }
  let low = 0;
  let high = indexedLines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (indexedLines[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function token(source: string, start: number, end: number, kind: CommentKind): CommentToken {
  return {
    start: lineAt(source, start),
    end: lineAt(source, Math.max(start, end - 1)),
    kind,
    directive: DIRECTIVE.test(source.slice(start, end)),
  };
}

function skipQuoted(source: string, offset: number, quote: string): number {
  for (let i = offset + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote || source[i] === '\n') return i;
  }
  return source.length - 1;
}

function shifted(tokens: CommentToken[], source: string, offset: number): CommentToken[] {
  const lineOffset = lineAt(source, offset) - 1;
  return tokens.map((item) => ({ ...item, start: item.start + lineOffset, end: item.end + lineOffset }));
}

function embeddedLanguage(shebang: string): string | null {
  if (/\bpython(?:3)?\b/.test(shebang)) return 'python';
  if (/\b(?:node|bun|deno)\b/.test(shebang)) return 'javascript';
  if (/\b(?:ba|z|da)?sh\b/.test(shebang)) return 'shell';
  return null;
}

function embeddedTemplateComments(
  source: string,
  start: number,
  end: number,
  holes: Array<[number, number]>,
): CommentToken[] {
  const raw = source.slice(start, end);
  const taggedRaw = /String\.raw\s*`$/.test(source.slice(Math.max(0, start - 32), start));
  if (!raw.startsWith('#!') && !taggedRaw) return [];
  const language = raw.startsWith('#!')
    ? embeddedLanguage(raw.split(/\r?\n|\\n/, 1)[0])
    : (/^\s*\$[A-Za-z_]/.test(raw) ? 'toml' : 'javascript');
  if (!language) return [];
  const masked = [...raw];
  for (const [holeStart, holeEnd] of holes) {
    for (let i = Math.max(start, holeStart); i < Math.min(end, holeEnd); i++) {
      const local = i - start;
      if (masked[local] !== '\n' && masked[local] !== '\r') masked[local] = ' ';
    }
  }
  const body = masked.join('');
  if (!body.includes('\n') && body.includes('\\n')) {
    const virtual = body.replace(/\\n/g, '\n');
    const tokens = scanSource(virtual, language);
    if (!tokens.length) return [];
    return [token(source, start, end, tokens.some((item) => item.directive) ? 'line' : tokens[0].kind)];
  }
  return shifted(scanSource(body, language), source, start);
}

function slashComments(source: string, jsx: boolean): CommentToken[] {
  const out: CommentToken[] = [];
  const contexts: Array<{
    kind: 'jsx' | 'template';
    depth: number;
    back: SlashMode;
    holeStart?: number;
    template?: { start: number; holes: Array<[number, number]> };
  }> = [];
  const templates: Array<{ start: number; holes: Array<[number, number]> }> = [];
  let mode: SlashMode = 'code';
  let canRegex = true;
  let jsxDepth = 0;
  const jsxBases: number[] = [];
  let closingTag = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === 'single' || mode === 'double') {
      if (ch === '\\') i++;
      else if (ch === (mode === 'single' ? "'" : '"') || ch === '\n') mode = 'code';
      continue;
    }
    if (mode === 'regex') {
      let inClass = false;
      for (; i < source.length; i++) {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) {
          while (/[a-z]/i.test(source[i + 1] ?? '')) i++;
          mode = 'code';
          canRegex = false;
          break;
        } else if (source[i] === '\n') {
          mode = 'code';
          break;
        }
      }
      continue;
    }
    if (mode === 'template') {
      if (ch === '\\') i++;
      else if (ch === '`') {
        const current = templates.pop();
        if (current) out.push(...embeddedTemplateComments(source, current.start, i, current.holes));
        mode = 'code';
        canRegex = false;
      } else if (ch === '$' && next === '{') {
        const current = templates.at(-1);
        contexts.push({ kind: 'template', depth: 1, back: 'template', holeStart: i, template: current });
        mode = 'code';
        canRegex = true;
        i++;
      }
      continue;
    }
    if (mode === 'jsx-text') {
      if (ch === '{') {
        contexts.push({ kind: 'jsx', depth: 1, back: 'jsx-text' });
        mode = 'code';
        canRegex = true;
      } else if (ch === '<') {
        closingTag = next === '/';
        mode = 'jsx-tag';
        if (closingTag) i++;
      }
      continue;
    }
    if (mode === 'jsx-tag') {
      if (ch === "'" || ch === '"') i = skipQuoted(source, i, ch);
      else if (ch === '{') {
        contexts.push({ kind: 'jsx', depth: 1, back: 'jsx-tag' });
        mode = 'code';
        canRegex = true;
      } else if (ch === '>') {
        const selfClosing = source[i - 1] === '/';
        if (closingTag) jsxDepth--;
        else if (!selfClosing) jsxDepth++;
        const base = jsxBases.at(-1);
        const completesRoot = base !== undefined
          && ((closingTag && jsxDepth === base) || (selfClosing && jsxDepth === base));
        closingTag = false;
        if (completesRoot) {
          jsxBases.pop();
          mode = 'code';
        } else mode = jsxDepth > 0 ? 'jsx-text' : 'code';
        canRegex = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      out.push(token(source, start, i, 'line'));
      canRegex = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length - 1, i + 1);
      out.push(token(source, start, i + 1, source[start + 2] === '*' ? 'doc' : 'block'));
      continue;
    }
    if (ch === "'" || ch === '"') {
      mode = ch === "'" ? 'single' : 'double';
      continue;
    }
    if (ch === '`') {
      templates.push({ start: i + 1, holes: [] });
      mode = 'template';
      continue;
    }
    if (jsx && ch === '<' && /[A-Za-z>/]/.test(next ?? '')) {
      jsxBases.push(jsxDepth);
      closingTag = next === '/';
      mode = 'jsx-tag';
      if (closingTag) i++;
      continue;
    }
    if (ch === '/' && canRegex) {
      mode = 'regex';
      continue;
    }
    if (ch === '{') {
      if (contexts.length) contexts.at(-1)!.depth++;
      canRegex = true;
      continue;
    }
    if (ch === '}') {
      const context = contexts.at(-1);
      if (context && --context.depth === 0) {
        contexts.pop();
        if (context.template && context.holeStart !== undefined) context.template.holes.push([context.holeStart, i + 1]);
        mode = context.back;
      }
      canRegex = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (/[\w$]/.test(source[i + 1] ?? '')) i++;
      const word = source.slice(start, i + 1);
      canRegex = /^(?:case|delete|do|else|in|instanceof|new|return|throw|typeof|void|yield)$/.test(word);
      continue;
    }
    if (/[0-9]/.test(ch) || /[)\]]/.test(ch)) {
      canRegex = false;
      continue;
    }
    if (/[,;:([=!&|?+*%~^-]/.test(ch)) canRegex = true;
  }
  return out;
}

function cssComments(source: string): CommentToken[] {
  const out: CommentToken[] = [];
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length - 1, i + 1);
      out.push(token(source, start, i + 1, 'block'));
    }
  }
  return out;
}

function heredocLanguage(command: string, delimiter: string): string | null {
  if (/\bpython(?:3)?\b/.test(command) || /^(?:PY|PYTHON)$/.test(delimiter)) return 'python';
  if (/\b(?:node|bun|deno)\b/.test(command) || /^(?:JS|JAVASCRIPT|NODE)$/.test(delimiter)) return 'javascript';
  if (/\b(?:ba|z|da)?sh\b/.test(command) || /^(?:SH|SHELL|BASH|BOOTSTRAP|REMOTE_EOF|SNIPPET)$/.test(delimiter)) return 'shell';
  if (/^(?:UNIT|SERVICE)$/.test(delimiter)) return 'toml';
  return null;
}

function hashComments(source: string, language: 'python' | 'shell' | 'toml' | 'yaml'): CommentToken[] {
  const out: CommentToken[] = [];
  let quote = '';
  let shellAnsiQuote = false;
  let triple = '';
  let blockIndent: number | null = null;
  let heredoc: { delimiter: string; stripTabs: boolean; language: string | null; start: number; body: string } | null = null;
  let offset = 0;

  for (const raw of source.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    if (language === 'shell' && heredoc) {
      const marker = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (marker === heredoc.delimiter) {
        if (heredoc.language) out.push(...shifted(scanSource(heredoc.body, heredoc.language), source, heredoc.start));
        heredoc = null;
      } else heredoc.body += raw;
      offset += raw.length;
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (language === 'yaml' && blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) {
        offset += raw.length;
        continue;
      }
      blockIndent = null;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (triple) {
        if (line.slice(i, i + 3) === triple) {
          i += 2;
          triple = '';
        } else if (ch === '\\' && triple === '"""') i++;
        continue;
      }
      if (quote) {
        if (ch === '\\' && (quote === '"' || language === 'python' || shellAnsiQuote)) i++;
        else if (ch === quote) {
          quote = '';
          shellAnsiQuote = false;
        }
        continue;
      }
      if ((language === 'python' || language === 'toml') && (line.slice(i, i + 3) === "'''" || line.slice(i, i + 3) === '"""')) {
        triple = line.slice(i, i + 3);
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        shellAnsiQuote = language === 'shell' && ch === "'" && line[i - 1] === '$';
        continue;
      }
      if (language === 'shell' && ch === '\\') {
        i++;
        continue;
      }
      if (ch !== '#') continue;
      if (i === 0 && offset === 0 && line.startsWith('#!')) break;
      if (language === 'shell') {
        const prev = line[i - 1] ?? '';
        if (prev && !/[\s;|&()]/.test(prev)) continue;
      }
      if (language === 'yaml' && i > 0 && !/\s/.test(line[i - 1])) continue;
      out.push(token(source, offset + i, offset + line.length, 'hash'));
      break;
    }
    if (language === 'yaml' && /(?:^|:\s*|-\s+)[|>](?:[+-]?[1-9]?|[1-9][+-]?)?\s*(?:#.*)?$/.test(line)) blockIndent = indent;
    if (language === 'shell') {
      const match = line.match(/(?<!<)<<(-)?(?!<)\s*(?:(['"])([^'"]+)\2|([A-Za-z_][\w-]*))/);
      if (match) {
        const delimiter = match[3] ?? match[4];
        heredoc = {
          delimiter,
          stripTabs: Boolean(match[1]),
          language: heredocLanguage(line.slice(0, match.index), delimiter),
          start: offset + raw.length,
          body: '',
        };
      }
    }
    offset += raw.length;
  }
  if (heredoc?.language) out.push(...shifted(scanSource(heredoc.body, heredoc.language), source, heredoc.start));
  return out;
}

function xmlComments(source: string): CommentToken[] {
  const out: CommentToken[] = [];
  let at = 0;
  while ((at = source.indexOf('<!--', at)) >= 0) {
    const end = source.indexOf('-->', at + 4);
    const stop = end < 0 ? source.length : end + 3;
    out.push(token(source, at, stop, 'xml'));
    at = stop;
  }
  return out;
}

function htmlComments(source: string): CommentToken[] {
  const out = xmlComments(source);
  const embedded = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of source.matchAll(embedded)) {
    const body = match[2];
    const offset = (match.index ?? 0) + match[0].indexOf(body);
    out.push(...shifted(scanSource(body, match[1].toLowerCase() === 'style' ? 'css' : 'javascript'), source, offset));
  }
  return out;
}

export function classifyPath(path: string, source?: string): string | null {
  if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  const name = basename(path);
  if (GENERATED_BASENAMES.has(name)) return null;
  if (name.startsWith('Dockerfile')) return 'shell';
  if (name === 'Makefile' || name === 'CODEOWNERS' || name === '.gitignore' || name === '.npmignore') return 'shell';
  const language = CODE_EXTENSIONS.get(extname(name).toLowerCase());
  if (language) return language;
  if (!extname(name) && source?.startsWith('#!')) return 'shell';
  if (IGNORED_BASENAMES.has(name) || IGNORED_EXTENSIONS.has(extname(name).toLowerCase())) return null;
  throw new Error(`unclassified tracked file: ${path}`);
}

export function scanSource(source: string, language: string): CommentToken[] {
  switch (language) {
    case 'typescript':
    case 'javascript': return slashComments(source, false);
    case 'css': return cssComments(source);
    case 'tsx':
    case 'jsx': return slashComments(source, true);
    case 'python': return hashComments(source, 'python');
    case 'shell': return hashComments(source, 'shell');
    case 'toml': return hashComments(source, 'toml');
    case 'yaml': return hashComments(source, 'yaml');
    case 'html': return htmlComments(source);
    case 'xml': return xmlComments(source);
    default: throw new Error(`unsupported comment language: ${language}`);
  }
}

function gitFiles(repoRoot: string): string[] {
  const proc = Bun.spawnSync({ cmd: ['git', 'ls-files', '-z'], cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString('utf8').trim());
  return Buffer.from(proc.stdout).toString('utf8').split('\0').filter(Boolean).sort();
}

export function scanRepository(repoRoot: string): CommentReport {
  const files: FileComments[] = [];
  let total = 0;
  let directives = 0;
  for (const path of gitFiles(repoRoot)) {
    const absolute = join(repoRoot, path);
    let source = '';
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      if (!IGNORED_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error(`cannot read tracked file: ${path}`);
      continue;
    }
    const language = classifyPath(path, source);
    if (!language) continue;
    const tokens = scanSource(source, language);
    const hitLines = new Set<number>();
    for (const item of tokens) for (let line = item.start; line <= item.end; line++) hitLines.add(line);
    const directiveLines = new Set(tokens.filter((item) => item.directive).flatMap((item) => {
      const lines: number[] = [];
      for (let line = item.start; line <= item.end; line++) lines.push(line);
      return lines;
    }));
    if (!hitLines.size) continue;
    total += hitLines.size;
    directives += directiveLines.size;
    files.push({ path, language, lines: hitLines.size, directives: directiveLines.size, tokens });
  }
  files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  return { schema: 'comment-lines-v1', total, target: COMMENT_TARGET, remaining: Math.max(0, total - COMMENT_TARGET), directives, files };
}

function loadBudget(text: string, label: string): Budget {
  const value = JSON.parse(text) as Budget;
  if (value.schema !== 'comment-budget-v1' || value.target !== COMMENT_TARGET || !Number.isSafeInteger(value.ceiling) || value.ceiling < 0) {
    throw new Error(`invalid ${label}: expected comment-budget-v1, target ${COMMENT_TARGET}, and a non-negative integer ceiling`);
  }
  return value;
}

function gitShow(repoRoot: string, ref: string, path: string): string | null {
  const proc = Bun.spawnSync({ cmd: ['git', 'show', `${ref}:${path}`], cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  return proc.exitCode === 0 ? Buffer.from(proc.stdout).toString('utf8') : null;
}

function parseArgs(argv: string[]): { base?: string; check: boolean; json: boolean; ndjson: boolean } {
  const result: ReturnType<typeof parseArgs> = { check: false, json: false, ndjson: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') result.base = argv[++i];
    else if (argv[i] === '--check') result.check = true;
    else if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--ndjson') result.ndjson = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return result;
}

function repoRoot(cwd = process.cwd()): string {
  const proc = Bun.spawnSync({ cmd: ['git', 'rev-parse', '--show-toplevel'], cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error('comment-lines must run inside a git worktree');
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

export function checkBudget(repo: string, report: CommentReport, base?: string): Budget {
  const path = 'scripts/comment-budget.json';
  const current = loadBudget(readFileSync(join(repo, path), 'utf8'), path);
  if (report.total !== current.ceiling) throw new Error(`comment total ${report.total} does not equal recorded ceiling ${current.ceiling}; set ceiling to the exact total`);
  if (base) {
    const previousText = gitShow(repo, base, path);
    if (previousText) {
      const previous = loadBudget(previousText, `${base}:${path}`);
      if (current.ceiling > previous.ceiling) throw new Error(`comment ceiling increased from ${previous.ceiling} to ${current.ceiling}`);
      if (current.target !== previous.target) throw new Error(`comment target changed from ${previous.target} to ${current.target}`);
    }
  }
  return current;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = repoRoot();
  const report = scanRepository(repo);
  if (args.check) checkBudget(repo, report, args.base);
  if (args.ndjson) {
    for (const file of report.files) for (const item of file.tokens) console.log(JSON.stringify({ path: file.path, ...item }));
  } else if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.total} comment lines; target ${report.target}; ${report.remaining} remaining; ${report.directives} directive lines`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
