#!/usr/bin/env bun
/**
 * Exact impact planner for the required Linux CI check (RUSH-2666).
 *
 * `scripts/ci-scope.ts --base <sha> --head <sha> --json` is the canonical
 * interface. Non-JSON mode prints the changed-file → test/check → reason table.
 * Unmapped production paths fail the policy check; there is no full-suite fallback.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const POLICY_VERSION = 'impact-v1';
export const IMPACT_BUDGET_SEC = 85;

export interface CiScope {
  cli: boolean;
  cliDocs: boolean;
  sessionTracker: boolean;
  windows: boolean;
}

export interface SelectedTest {
  file: string;
  reason: string;
}

export interface ImpactPlan {
  selection_base_sha: string;
  pr_head_sha: string;
  candidate_tree_sha: string;
  policy_version: string;
  policy_digest: string;
  lockfile_digest: string;
  suite: 'selected' | 'cli-full';
  /** Resolved seconds budget; absent means {@link IMPACT_BUDGET_SEC}. */
  budget_sec?: number;
  tests: SelectedTest[];
  checks: string[];
  platforms: string[];
  unmapped: string[];
  zero_selection: string[];
  mapping: Array<{ file: string; selected: string; reason: string }>;
}

export interface ImpactProof {
  schema: 'impact-proof-v1';
  policy_version: string;
  policy_digest: string;
  lockfile_digest: string;
  candidate_tree_sha: string;
  platform: string;
  suite: ImpactPlan['suite'];
  tests: string[];
  checks: string[];
  result: 'pass';
  bun: string;
}

interface OwnershipGroup {
  id: string;
  when: string[];
  tests?: string[];
  checks?: string[];
  suite?: 'selected' | 'cli-full' | 'metadata-gated';
  /**
   * Seconds this group's selection is allowed, overriding {@link IMPACT_BUDGET_SEC}.
   *
   * The gate had exactly two tiers — 85s for `selected`, 1200s for `cli-full` — and a
   * legitimately medium selection had nowhere to sit. `sessions` is the case that
   * forced it: ANY edit to `cli/src/commands/sessions.ts`, a two-line subcommand
   * registration included, pulls in the whole `sessions*` suite, measured at 92s of
   * vitest inside a 122s run (PR #2771, run 32032566960). It could never pass 85s, so
   * no new `agents sessions <verb>` could merge; `cli-full` would have handed a large
   * and busy area a 20-minute allowance instead, which is the opposite of the point.
   *
   * Only ever RAISES the ceiling — enforced, not merely asserted: the resolution
   * clamps at {@link IMPACT_BUDGET_SEC}, so a group cannot tighten the gate for
   * itself, and the highest budget among the matched groups wins because the run
   * executes the union of their selections. A malformed value throws at manifest
   * load rather than coercing to the default. Keep any value here justified by a
   * measured run, not a round number.
   */
  budget_sec?: number;
  /** Apply this budget only to a deduplicated CLI test selection this large. */
  budget_min_selected_cli_tests?: number;
}

interface OwnershipArea {
  prefix: string;
  companion?: boolean;
  related?: boolean;
  checks?: string[];
}

export interface OwnershipManifest {
  policy_version: string;
  areas: OwnershipArea[];
  groups: OwnershipGroup[];
  testless: string[];
}

const DEFAULT_MANIFEST = join(import.meta.dir, '..', 'cli/ci/test-ownership.yaml');
const CLI_TEST_GLOBS = [
  /\/tests\/.*\.test\.ts$/,
  /\/src\/.*\.test\.ts$/,
  /\/scripts\/.*\.test\.ts$/,
  /\/__tests__\/.*\.test\.ts$/,
];

const EXECUTABLE = /\.(ts|tsx|js|mjs|cjs|sh)$/;

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

export function posix(file: string): string {
  return file.split(sep).join('/');
}

export function matchGlob(glob: string, file: string): boolean {
  const f = posix(file);
  const g = posix(glob);
  if (g.endsWith('/**')) {
    const prefix = g.slice(0, -2);
    const dir = g.slice(0, -3);
    return f === dir || f.startsWith(prefix);
  }
  if (!g.includes('*')) return f === g;
  const escaped = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(f);
}

export function loadOwnershipManifest(path = DEFAULT_MANIFEST): OwnershipManifest {
  const parsed = Bun.YAML.parse(readFileSync(path, 'utf8')) as OwnershipManifest;
  if (!parsed?.policy_version) throw new Error(`invalid ownership manifest: ${path}`);
  parsed.areas ??= [];
  parsed.groups ??= [];
  parsed.testless ??= [];
  // Fail loud on a malformed budget rather than coercing it. A string, a zero, or a
  // negative would otherwise be swallowed by truthiness and silently fall back to
  // the default — a gate that reads stricter than the manifest says is exactly the
  // kind of quiet disagreement this policy file exists to prevent.
  for (const group of parsed.groups) {
    if (group.budget_min_selected_cli_tests !== undefined && (
      !Number.isSafeInteger(group.budget_min_selected_cli_tests)
      || group.budget_min_selected_cli_tests <= 0
      || group.budget_sec === undefined
    )) {
      throw new Error(`invalid budget_min_selected_cli_tests on group '${group.id}' in ${path}: expected a positive integer and budget_sec`);
    }
    if (group.budget_sec === undefined) continue;
    if (typeof group.budget_sec !== 'number' || !Number.isFinite(group.budget_sec) || group.budget_sec <= 0) {
      throw new Error(
        `invalid budget_sec on group '${group.id}' in ${path}: expected a positive number, got ${JSON.stringify(group.budget_sec)}`,
      );
    }
  }
  return parsed;
}

function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function sha256File(path: string): string {
  return sha256Text(readFileSync(path));
}

export function policyDigest(repoRoot: string): string {
  const parts = [
    join(repoRoot, 'cli/vitest.config.ts'),
    join(repoRoot, 'cli/ci/test-ownership.yaml'),
    join(repoRoot, 'scripts/ci-scope.ts'),
  ]
    .filter((p) => existsSync(p))
    .map((p) => `${sha256File(p).slice('sha256:'.length)}  ${posix(relative(repoRoot, p))}`)
    .join('\n');
  return sha256Text(parts + '\n');
}

export function lockfileDigest(repoRoot: string): string {
  const lock = join(repoRoot, 'cli/bun.lock');
  if (!existsSync(lock)) return '';
  return sha256File(lock);
}

export function gitRevParse(ref: string, cwd: string): string {
  const proc = Bun.spawnSync({
    cmd: ['git', 'rev-parse', ref],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8').trim() || `git rev-parse ${ref} failed`);
  }
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

function gitShowFile(ref: string, file: string, cwd: string): string | null {
  const proc = Bun.spawnSync({
    cmd: ['git', 'show', `${ref}:${file}`],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  return Buffer.from(proc.stdout).toString('utf8');
}

export type PackageJsonChangeKind = 'version-only' | 'dependency' | 'unknown';

/**
 * A `package.json` diff is `version-only` only when every key besides
 * `version` is byte-identical before vs after. Missing refs, unreadable
 * blobs, and unparsable JSON all fall back to `unknown` — the caller treats
 * that the same as a real dependency change (fail-closed, RUSH-2666).
 */
export function classifyPackageJsonChange(
  file: string,
  repoRoot: string,
  baseSha?: string,
  headSha?: string,
): PackageJsonChangeKind {
  if (!baseSha || !headSha) return 'unknown';
  const before = gitShowFile(baseSha, file, repoRoot);
  const after = gitShowFile(headSha, file, repoRoot);
  if (before === null || after === null) return 'unknown';
  try {
    const { version: _beforeVersion, ...beforeRest } = JSON.parse(before) as Record<string, unknown>;
    const { version: _afterVersion, ...afterRest } = JSON.parse(after) as Record<string, unknown>;
    return JSON.stringify(beforeRest) === JSON.stringify(afterRest) ? 'version-only' : 'dependency';
  } catch {
    return 'unknown';
  }
}

// Rename-aware changed-file parse (PHNX-3200). `--no-renames` reported a `git mv`
// as an add of the new path PLUS a delete of the old one, so a pure structural
// move (the #3033 flatten renamed ~2100 files 100%) read as ~2100 *changed* files
// — selecting suite=cli-full and tripping zero-selection on every moved source
// that carried no test at its new path. A 100%-similarity move is not a change,
// so it should select nothing.
//
// Parses `git diff --raw -z` (NOT `--name-status`): the raw metadata carries the
// old and new file MODE, which `--name-status` hides. A `git mv foo.sh bar.sh &&
// chmod +x bar.sh` is `R100` by content-similarity but flips the executable bit
// — a real change to a script this repo runs directly. So the destination is
// selected whenever content changed (similarity < 100) OR the mode changed, and
// only a truly identical move (same content AND same mode) selects nothing.
export function parseRenameAwareRawDiff(z: string): string[] {
  const tokens = z.split('\0');
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i];
    // Each record's metadata is one field: ":<oldmode> <newmode> <oldsha> <newsha> <status>".
    if (!meta || meta[0] !== ':') {
      i++;
      continue;
    }
    const parts = meta.slice(1).split(' ');
    const oldMode = parts[0];
    const newMode = parts[1];
    const status = parts[4] ?? '';
    const code = status[0];
    if (code === 'R' || code === 'C') {
      // A rename/copy carries two paths: `<meta>\0<old>\0<new>`.
      const score = Number.parseInt(status.slice(1), 10);
      const to = tokens[i + 2];
      i += 3;
      if (to && (score < 100 || oldMode !== newMode)) out.push(to);
    } else {
      // A / M / D / T carry one path: `<meta>\0<path>`.
      const path = tokens[i + 1];
      i += 2;
      if (path) out.push(path);
    }
  }
  return out;
}

export function changedFilesBetween(base: string, head: string, cwd = process.cwd()): string[] {
  const proc = Bun.spawnSync({
    cmd: [
      'git',
      'diff',
      // Rename-aware: git pairs an add+delete it recognizes (default 50%
      // similarity) as a single `R<score>` entry, so a structural move stops
      // reading as two changed files. Sub-threshold moves stay add+delete, which
      // is correct — they really did change. `--raw` (not `--name-status`) is
      // what carries the per-file mode, so a rename that also flips +x is not
      // mistaken for a no-op move.
      '--raw',
      '--find-renames',
      '--diff-filter=ACMRTD',
      '-z',
      `${base}...${head}`,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8').trim());
  }
  return parseRenameAwareRawDiff(Buffer.from(proc.stdout).toString('utf8'));
}

export function trackedFiles(cwd: string): string[] {
  const proc = Bun.spawnSync({
    cmd: ['git', 'ls-files', '-z'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8').trim());
  }
  return Buffer.from(proc.stdout).toString('utf8').split('\0').filter(Boolean);
}

export function isTestFile(file: string): boolean {
  const f = posix(file);
  return CLI_TEST_GLOBS.some((re) => re.test(`/${f}`)) || f.endsWith('.test.ts') || f.endsWith('.test.sh');
}

export function isExecutableSource(file: string): boolean {
  const f = posix(file);
  return EXECUTABLE.test(f) && !isTestFile(f);
}

export function companionCandidates(file: string): string[] {
  const f = posix(file);
  if (isTestFile(f)) return [];
  const ext = f.match(/\.(ts|tsx|js|mjs|cjs|sh)$/);
  if (!ext) return [];
  const noExt = f.slice(0, -ext[0].length);
  const base = noExt.split('/').pop() ?? '';
  const dir = noExt.slice(0, Math.max(0, noExt.lastIndexOf('/')));
  const out = [`${noExt}.test.ts`, `${noExt}.test.sh`];
  if (dir.includes('/src/')) {
    out.push(`${dir}/__tests__/${base}.test.ts`);
    out.push(`${noExt.replace('/src/', '/tests/')}.test.ts`);
  }
  return out;
}

export function existingCompanions(file: string, repoRoot: string): string[] {
  return companionCandidates(file).filter((c) => existsSync(join(repoRoot, c)));
}

function classifyPath(file: string, manifest: OwnershipManifest): {
  area?: OwnershipArea;
  groups: OwnershipGroup[];
  testless: boolean;
} {
  const area = [...manifest.areas]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((a) => posix(file).startsWith(posix(a.prefix)));
  const groups = manifest.groups.filter((g) => g.when.some((glob) => matchGlob(glob, file)));
  const testless = manifest.testless.some((glob) => matchGlob(glob, file));
  return { area, groups, testless };
}

export function isClassified(file: string, manifest: OwnershipManifest): boolean {
  const c = classifyPath(file, manifest);
  return Boolean(c.area || c.testless || c.groups.length);
}

export function validateOwnershipManifest(
  manifest: OwnershipManifest,
  repoRoot: string,
): { unmapped: string[]; missingTests: string[]; deadGlobs: string[] } {
  const tracked = trackedFiles(repoRoot);
  const unmapped = tracked.filter((file) => !isClassified(file, manifest));
  const missingTests: string[] = [];
  const deadGlobs: string[] = [];
  for (const group of manifest.groups) {
    for (const test of group.tests ?? []) {
      if (!existsSync(join(repoRoot, test))) missingTests.push(`${group.id}:${test}`);
    }
    for (const glob of group.when) {
      if (!tracked.some((file) => matchGlob(glob, file))) {
        deadGlobs.push(`${group.id}:${glob}`);
      }
    }
  }
  return { unmapped, missingTests, deadGlobs };
}

const IMPORT_RE = /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g;

function resolveImport(fromFile: string, spec: string, repoRoot: string): string | null {
  const base = resolve(repoRoot, dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  for (const c of candidates) {
    if (existsSync(c)) return posix(relative(repoRoot, c));
  }
  return null;
}

export function buildImportGraph(repoRoot: string, files: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const imports: string[] = [];
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(text))) {
      const resolved = resolveImport(file, match[1], repoRoot);
      if (resolved) imports.push(resolved);
    }
    graph.set(posix(file), imports);
  }
  return graph;
}

export function relatedTestFiles(
  changed: readonly string[],
  repoRoot: string,
  files?: readonly string[],
): string[] {
  const byFile = relatedTestsBySource(changed, repoRoot, files);
  return [...new Set([...byFile.values()].flat())];
}

function invertGraphOntoChanged(
  graph: Map<string, string[]>,
  changedSet: Set<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of changedSet) out.set(file, []);
  for (const [from, tos] of graph) {
    if (!isTestFile(from) || changedSet.has(from)) continue;
    for (const to of tos) {
      if (!changedSet.has(to)) continue;
      out.get(to)!.push(from);
    }
  }
  return out;
}

export function relatedTestsBySource(
  changed: readonly string[],
  repoRoot: string,
  files?: readonly string[],
): Map<string, string[]> {
  const universe = files ?? trackedFiles(repoRoot).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const graph = buildImportGraph(repoRoot, universe);
  return invertGraphOntoChanged(graph, new Set(changed.map(posix)));
}

// A test that reads its script-under-test with `readFileSync` at runtime (to
// assert on its literal source, or via `path.resolve(__dirname, ...)`) has a
// real dependency edge the static IMPORT_RE graph above can never see — there
// is no `import "./release.sh"` to find (RUSH-3097). This resolves that one
// runtime pattern the same way buildImportGraph resolves static imports: a
// literal filename passed to readFileSync, either inline as
// `path.resolve(__dirname, 'LIT')` / `path.join(__dirname, 'LIT')`, or via a
// same-file `const NAME = path.resolve(__dirname, 'LIT')` the read then
// references by name. It deliberately does not attempt general data-flow
// analysis beyond that one indirection — a test that hides the path behind
// anything more dynamic than a same-file constant needs a real import instead.
const PATH_VARIABLE_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*__dirname\s*,\s*(['"])([^'"]+)\2\s*\)/g;
const RUNTIME_READ_INLINE_RE = /readFileSync\s*\(\s*(?:path\.)?(?:resolve|join)\(\s*__dirname\s*,\s*(['"])([^'"]+)\1\s*\)/g;
const RUNTIME_READ_VAR_RE = /readFileSync\s*\(\s*(\w+)\s*[,)]/g;

export function extractRuntimeReadLiterals(text: string): string[] {
  const vars = new Map<string, string>();
  PATH_VARIABLE_RE.lastIndex = 0;
  let vm: RegExpExecArray | null;
  while ((vm = PATH_VARIABLE_RE.exec(text))) vars.set(vm[1], vm[3]);

  const literals = new Set<string>();
  RUNTIME_READ_INLINE_RE.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = RUNTIME_READ_INLINE_RE.exec(text))) literals.add(im[2]);

  RUNTIME_READ_VAR_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = RUNTIME_READ_VAR_RE.exec(text))) {
    const literal = vars.get(am[1]);
    if (literal) literals.add(literal);
  }
  return [...literals];
}

export function buildRuntimeReadGraph(repoRoot: string, files: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    if (!text.includes('readFileSync')) continue;
    const targets: string[] = [];
    for (const literal of extractRuntimeReadLiterals(text)) {
      const resolved = resolve(repoRoot, dirname(file), literal);
      if (existsSync(resolved)) targets.push(posix(relative(repoRoot, resolved)));
    }
    if (targets.length) graph.set(posix(file), targets);
  }
  return graph;
}

export function runtimeReadTestsBySource(
  changed: readonly string[],
  repoRoot: string,
  files?: readonly string[],
): Map<string, string[]> {
  const universe = files ?? trackedFiles(repoRoot).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const graph = buildRuntimeReadGraph(repoRoot, universe);
  return invertGraphOntoChanged(graph, new Set(changed.map(posix)));
}

function addTest(
  selected: Map<string, string>,
  mapping: ImpactPlan['mapping'],
  changedFile: string,
  testFile: string,
  reason: string,
): void {
  if (!selected.has(testFile)) selected.set(testFile, reason);
  mapping.push({ file: changedFile, selected: testFile, reason });
}

function addCheck(
  checks: Set<string>,
  mapping: ImpactPlan['mapping'],
  changedFile: string,
  check: string,
  reason: string,
): void {
  checks.add(check);
  mapping.push({ file: changedFile, selected: `check:${check}`, reason });
}

export interface SelectImpactInput {
  files: readonly string[];
  repoRoot: string;
  manifest?: OwnershipManifest;
  baseSha?: string;
  headSha?: string;
  treeSha?: string;
  related?: boolean;
}

export function selectImpact(input: SelectImpactInput): ImpactPlan {
  const manifest = input.manifest ?? loadOwnershipManifest();
  const repoRoot = input.repoRoot;
  const selected = new Map<string, string>();
  const checks = new Set<string>();
  const mapping: ImpactPlan['mapping'] = [];
  const unmapped: string[] = [];
  const zeroSelection: string[] = [];
  let suite: ImpactPlan['suite'] = 'selected';
  let budgetSec = 0;
  const budgetGroups = new Set<OwnershipGroup>();

  const relatedByDefault = input.related !== false;
  const relatedBySource = relatedByDefault
    ? relatedTestsBySource(input.files, repoRoot)
    : new Map<string, string[]>();
  const runtimeReadBySource = relatedByDefault
    ? runtimeReadTestsBySource(input.files, repoRoot)
    : new Map<string, string[]>();

  for (const raw of input.files) {
    const file = posix(raw);
    const { area, groups, testless } = classifyPath(file, manifest);
    if (!area && !testless && groups.length === 0) {
      unmapped.push(file);
      continue;
    }

    let selectedForFile = 0;
    const mark = () => {
      selectedForFile += 1;
    };

    // A testless-exempt path never selects tests — including its own changed
    // test files — and a DELETED test file is a change with nothing left to
    // run. Both cases come from the same PR shape: removing a tree (apps/ext/**
    // moved to phnx-labs/agi-ext) must not queue its removed tests as work.
    if (isTestFile(file) && !testless && existsSync(join(repoRoot, file))) {
      addTest(selected, mapping, file, file, 'changed-test');
      mark();
    }

    if (area?.companion || file.startsWith('cli/') || file.startsWith('scripts/')) {
      for (const companion of existingCompanions(file, repoRoot)) {
        addTest(selected, mapping, file, companion, 'companion');
        mark();
      }
    }

    if ((area?.related ?? file.startsWith('cli/')) && relatedByDefault) {
      for (const test of relatedBySource.get(file) ?? []) {
        addTest(selected, mapping, file, test, 'static-import');
        mark();
      }
      for (const test of runtimeReadBySource.get(file) ?? []) {
        addTest(selected, mapping, file, test, 'runtime-read');
        mark();
      }
    }

    for (const check of area?.checks ?? []) {
      addCheck(checks, mapping, file, check, `area:${area?.prefix ?? ''}`);
      mark();
    }

    for (const group of groups) {
      const groupSuite = group.suite === 'metadata-gated'
        ? (classifyPackageJsonChange(file, repoRoot, input.baseSha, input.headSha) === 'version-only'
          ? 'selected'
          : 'cli-full')
        : group.suite;
      if (groupSuite === 'cli-full') suite = 'cli-full';
      if (group.budget_sec) budgetGroups.add(group);
      for (const test of group.tests ?? []) {
        addTest(selected, mapping, file, test, `owner:${group.id}`);
        mark();
      }
      for (const check of group.checks ?? []) {
        addCheck(checks, mapping, file, check, `owner:${group.id}`);
        mark();
      }
    }

    if (testless && selectedForFile === 0) {
      mapping.push({ file, selected: '(none)', reason: 'testless' });
      continue;
    }

    // A deleted source selects nothing by construction (its companions are
    // existence-filtered and its own test may be gone with it) — that is not
    // the missing-coverage signal zero_selection exists to catch.
    if (isExecutableSource(file) && selectedForFile === 0 && !testless && existsSync(join(repoRoot, file))) {
      zeroSelection.push(file);
    }
  }

  const tests = [...selected.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, reason]) => ({ file, reason }));
  const selectedCliTests = tests.filter(({ file }) => file.startsWith('cli/') && file.endsWith('.test.ts')).length;
  for (const group of budgetGroups) {
    if (selectedCliTests < (group.budget_min_selected_cli_tests ?? 0)) continue;
    // Only raise the ceiling. Size-qualified budgets observe the final union,
    // never duplicated mappings or just one changed file's import graph.
    budgetSec = Math.max(budgetSec, group.budget_sec!, IMPACT_BUDGET_SEC);
  }

  return {
    selection_base_sha: input.baseSha ?? '',
    pr_head_sha: input.headSha ?? '',
    candidate_tree_sha: input.treeSha ?? '',
    policy_version: manifest.policy_version,
    policy_digest: existsSync(join(repoRoot, 'scripts/ci-scope.ts')) ? policyDigest(repoRoot) : '',
    lockfile_digest: lockfileDigest(repoRoot),
    suite,
    ...(budgetSec > 0 ? { budget_sec: budgetSec } : {}),
    tests,
    checks: [...checks].sort(),
    platforms: ['linux'],
    unmapped,
    zero_selection: zeroSelection,
    mapping,
  };
}

export function scopeFromPlan(plan: ImpactPlan): CiScope {
  const has = (name: string) => plan.checks.includes(name);
  const testUnder = (prefix: string) => plan.tests.some((t) => t.file.startsWith(prefix));
  return {
    cli: has('typecheck') || has('binary-smoke') || has('command-index') || has('impact-tests')
      || has('sessions-bench') || testUnder('cli/') || plan.suite === 'cli-full',
    cliDocs: has('docs') || has('command-index'),
    sessionTracker: has('session-tracker'),
    windows: false,
  };
}

export function classifyCiScope(files: readonly string[], repoRoot = repoRootFrom()): CiScope {
  return scopeFromPlan(selectImpact({ files, repoRoot }));
}

export function formatGitHubOutputs(
  scope: CiScope,
  extra: Record<string, string> = {},
): string {
  const rows: Record<string, string> = {
    cli: String(scope.cli),
    cli_docs: String(scope.cliDocs),
    session_tracker: String(scope.sessionTracker),
    windows: String(scope.windows),
    ...extra,
  };
  return Object.entries(rows).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

export function formatMappingTable(plan: ImpactPlan): string {
  const lines = [
    `policy ${plan.policy_version}  tree ${plan.candidate_tree_sha || '(none)'}  suite ${plan.suite}`,
    'changed file\tselected\treason',
    ...plan.mapping.map((row) => `${row.file}\t${row.selected}\t${row.reason}`),
  ];
  if (plan.unmapped.length) lines.push(`UNMAPPED\t${plan.unmapped.join(' ')}`);
  if (plan.zero_selection.length) lines.push(`ZERO_SELECTION\t${plan.zero_selection.join(' ')}`);
  return lines.join('\n') + '\n';
}

export function planIsFailing(plan: ImpactPlan): boolean {
  return plan.unmapped.length > 0 || plan.zero_selection.length > 0;
}

export function proofFromPlan(plan: ImpactPlan, bunVersion: string): ImpactProof {
  return {
    schema: 'impact-proof-v1',
    policy_version: plan.policy_version,
    policy_digest: plan.policy_digest,
    lockfile_digest: plan.lockfile_digest,
    candidate_tree_sha: plan.candidate_tree_sha,
    platform: 'linux',
    suite: plan.suite,
    tests: plan.tests.map((t) => t.file),
    checks: plan.checks,
    result: 'pass',
    bun: bunVersion,
  };
}

export function canReuseProof(proof: ImpactProof, plan: ImpactPlan, bunVersion: string): boolean {
  return proof.schema === 'impact-proof-v1'
    && proof.result === 'pass'
    && proof.candidate_tree_sha !== ''
    && proof.candidate_tree_sha === plan.candidate_tree_sha
    && proof.policy_digest === plan.policy_digest
    && proof.lockfile_digest === plan.lockfile_digest
    && proof.policy_version === plan.policy_version
    && proof.platform === 'linux'
    && proof.suite === plan.suite
    && proof.bun === bunVersion;
}

export interface RunCommand {
  cwd: string;
  cmd: string[];
}

export function commandForTestFile(file: string, repoRoot: string): RunCommand {
  const f = posix(file);
  if (f.endsWith('.test.sh')) {
    return { cwd: join(repoRoot, dirname(f)), cmd: ['bash', f.split('/').pop()!] };
  }
  if (f.startsWith('cli/') && f.endsWith('.test.ts')) {
    return {
      cwd: join(repoRoot, 'cli'),
      // No `--` before the path: vitest's CLI treats args after `--` as an
      // opaque pass-through, not a filter, so the file list is silently
      // dropped and vitest falls back to its full `include` glob. Measured
      // on PR #2770 (RUSH-2666): the plan selected 3 files, the `--`
      // invocation ran all 864, "Selected proof" took 15m21s instead of ~13s.
      cmd: ['node', './node_modules/vitest/vitest.mjs', 'run', f.slice('cli/'.length)],
    };
  }
  if (f.startsWith('packages/session-tracker/') && f.endsWith('.test.ts')) {
    return {
      cwd: join(repoRoot, 'packages/session-tracker'),
      cmd: ['bun', 'run', 'test', '--', f.slice('packages/session-tracker/'.length)],
    };
  }
  if (f.endsWith('.test.ts')) {
    return { cwd: repoRoot, cmd: ['bun', 'test', `./${f}`] };
  }
  throw new Error(`no runner for selected test: ${f}`);
}

export function commandsForPlan(plan: ImpactPlan, repoRoot: string): RunCommand[] {
  const out: RunCommand[] = [];
  const cli = join(repoRoot, 'cli');
  if (plan.suite === 'cli-full') {
    out.push({ cwd: cli, cmd: ['node', './node_modules/vitest/vitest.mjs', 'run'] });
  } else {
    const cliTests = plan.tests
      .map((t) => t.file)
      .filter((f) => f.startsWith('cli/') && f.endsWith('.test.ts'))
      .map((f) => f.slice('cli/'.length));
    if (cliTests.length) {
      // No `--` — see commandForTestFile above for why.
      out.push({
        cwd: cli,
        cmd: ['node', './node_modules/vitest/vitest.mjs', 'run', ...cliTests],
      });
    }
  }
  for (const test of plan.tests) {
    if (test.file.startsWith('cli/') && test.file.endsWith('.test.ts')) continue;
    out.push(commandForTestFile(test.file, repoRoot));
  }
  for (const check of plan.checks) {
    switch (check) {
      case 'typecheck':
        // Already proven: `bun install` (installCommandsForPlan) runs the CLI's
        // `prepare` script, which is `npm run build`, which is `tsc`. Running
        // the build a second time here cost a measured 18s on every selected
        // run (PR #3568: 126s against a 120s budget, 2113 tests green).
        // ci-scope.test.ts pins both halves of that invariant.
        break;
      case 'command-index':
        out.push({ cwd: cli, cmd: ['bash', 'scripts/verify-command-index.sh'] });
        break;
      case 'docs':
        out.push({ cwd: cli, cmd: ['bash', 'scripts/verify-docs.sh'] });
        break;
      case 'binary-smoke':
        out.push({ cwd: cli, cmd: ['bash', 'scripts/build-bin.sh'] });
        out.push({ cwd: cli, cmd: ['./dist/bin/agents', '--version'] });
        break;
      case 'sessions-bench':
        out.push({ cwd: cli, cmd: ['bun', 'bench/sessions-active-perf.ts'] });
        break;
      case 'session-tracker':
        out.push({
          cwd: join(repoRoot, 'packages/session-tracker'),
          cmd: ['bun', 'run', 'test', '--', 'tests/state-file.test.ts'],
        });
        break;
      case 'impact-tests':
        out.push({ cwd: repoRoot, cmd: ['bun', 'test', 'scripts/ci-scope.test.ts'] });
        break;
      case 'workflow-policy':
        out.push({ cwd: repoRoot, cmd: ['bun', 'test', './.github/workflows/', './scripts/ci-bench/'] });
        break;
      default:
        throw new Error(`unknown check: ${check}`);
    }
  }
  return out;
}

export function installCommandsForPlan(plan: ImpactPlan, repoRoot: string): RunCommand[] {
  const out: RunCommand[] = [];
  const needsCli = plan.suite === 'cli-full'
    || plan.tests.some((t) => t.file.startsWith('cli/'))
    || plan.checks.some((c) => ['typecheck', 'command-index', 'docs', 'binary-smoke', 'sessions-bench'].includes(c));
  // The CLI install is also the typecheck: its `prepare` script builds with tsc
  // (see the `typecheck` case in commandsForPlan).
  if (needsCli) out.push({ cwd: join(repoRoot, 'cli'), cmd: ['bun', 'install', '--frozen-lockfile'] });
  if (plan.checks.includes('session-tracker')) {
    out.push({
      cwd: join(repoRoot, 'packages/session-tracker'),
      cmd: ['bun', 'install', '--frozen-lockfile'],
    });
  }
  return out;
}

function readChangedFilesFromStdin(): string[] {
  const input = readFileSync(0);
  const separator = input.includes(0) ? '\0' : '\n';
  return input.toString('utf8').split(separator).filter(Boolean);
}

function parseArgs(argv: string[]): {
  base?: string;
  head?: string;
  json: boolean;
  validate: boolean;
  run?: string;
  planFile?: string;
  proofWrite?: string;
  proofReuse?: string;
  githubOutput?: string;
  deadlineSec?: number;
} {
  const out: ReturnType<typeof parseArgs> = { json: false, validate: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--base': out.base = next(); break;
      case '--head': out.head = next(); break;
      case '--json': out.json = true; break;
      case '--validate-manifest': out.validate = true; break;
      case '--run': out.run = next(); break;
      case '--plan-file': out.planFile = next(); break;
      case '--write-proof': out.proofWrite = next(); break;
      case '--reuse-proof': out.proofReuse = next(); break;
      case '--github-output': out.githubOutput = next(); break;
      case '--deadline-sec': out.deadlineSec = Number(next()); break;
      case '--fail-unmapped': break;
      default: rest.push(a);
    }
  }
  if (!out.base && rest[0] && rest[1] && !rest[0].startsWith('--')) {
    out.base = rest[0];
    out.head = rest[1];
    out.githubOutput = rest[2] ?? out.githubOutput;
  } else if (!out.base && rest[0] && !out.run && !out.validate && !out.proofReuse) {
    out.githubOutput = rest[0];
  }
  return out;
}

/**
 * Vitest exits 1 on an unhandled "Worker exited unexpectedly" even when
 * every test file and every test passed. The required Linux `test` check
 * then stays red on a green suite (measured twice on #2622, 863 files /
 * 12206 tests passed, 0 failed).
 */
export function isVitestWorkerCrashWithZeroFailures(output: string): boolean {
  if (!/Worker exited unexpectedly/.test(output)) return false;
  const testFilesLine = output.match(/^\s*Test Files\s+.+$/m)?.[0] ?? '';
  const testsLine = output.match(/^\s*Tests\s+.+$/m)?.[0] ?? '';
  if (!testFilesLine || !testsLine) return false;
  if (/\bfailed\b/.test(testFilesLine) || /\bfailed\b/.test(testsLine)) return false;
  return /\bpassed\b/.test(testsLine);
}

function runCmd(spec: RunCommand): void {
  const proc = Bun.spawnSync({
    cmd: spec.cmd,
    cwd: spec.cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  if (proc.exitCode !== 0) {
    throw new Error(`command failed (${proc.exitCode}): ${spec.cmd.join(' ')}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootFrom();
  const manifest = loadOwnershipManifest();

  if (args.validate) {
    const result = validateOwnershipManifest(manifest, repoRoot);
    if (result.unmapped.length || result.missingTests.length || result.deadGlobs.length) {
      process.stderr.write(
        `unmapped (${result.unmapped.length}):\n${result.unmapped.map((f) => `  ${f}`).join('\n')}\n`
        + `missing tests:\n${result.missingTests.map((f) => `  ${f}`).join('\n')}\n`
        + `dead when-globs:\n${result.deadGlobs.map((f) => `  ${f}`).join('\n')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`ownership manifest covers ${trackedFiles(repoRoot).length} tracked files\n`);
    return;
  }

  if (args.run) {
    const plan = JSON.parse(readFileSync(args.run, 'utf8')) as ImpactPlan;
    if (planIsFailing(plan)) {
      process.stderr.write(formatMappingTable(plan));
      process.exit(1);
    }
    const started = Number(process.env.IMPACT_STARTED_AT ?? Date.now() / 1000);
    for (const spec of [...installCommandsForPlan(plan, repoRoot), ...commandsForPlan(plan, repoRoot)]) {
      runCmd(spec);
    }
    const elapsed = Math.round(Date.now() / 1000 - started);
    const deadline = plan.suite === 'cli-full'
      ? 1200
      : (args.deadlineSec ?? plan.budget_sec ?? IMPACT_BUDGET_SEC);
    process.stdout.write(`impact ran in ${elapsed}s (budget ${deadline}s, suite ${plan.suite})\n`);
    if (elapsed > deadline) {
      process.stderr.write(`::error::impact exceeded ${deadline}s budget (${elapsed}s)\n`);
      process.exit(1);
    }
    return;
  }

  const files = args.base && args.head
    ? changedFilesBetween(args.base, args.head, repoRoot)
    : readChangedFilesFromStdin();

  let treeSha = '';
  let selectionBase = args.base ?? '';
  if (args.head) {
    try {
      treeSha = gitRevParse(`${args.head}^{tree}`, repoRoot);
      if (args.base) {
        const proc = Bun.spawnSync({
          cmd: ['git', 'merge-base', args.base, args.head],
          cwd: repoRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (proc.exitCode === 0) {
          selectionBase = Buffer.from(proc.stdout).toString('utf8').trim();
        }
      }
    } catch {
      treeSha = '';
    }
  }

  const plan = selectImpact({
    files,
    repoRoot,
    manifest,
    baseSha: selectionBase,
    headSha: args.head,
    treeSha,
  });

  if (args.planFile) writeFileSync(args.planFile, `${JSON.stringify(plan, null, 2)}\n`);

  const bunVersion = Bun.version;
  let reused = false;
  if (args.proofReuse && existsSync(args.proofReuse)) {
    try {
      const proof = JSON.parse(readFileSync(args.proofReuse, 'utf8')) as ImpactProof;
      reused = canReuseProof(proof, plan, bunVersion);
    } catch {
      reused = false;
    }
  }

  if (args.proofWrite && !planIsFailing(plan)) {
    writeFileSync(args.proofWrite, `${JSON.stringify(proofFromPlan(plan, bunVersion), null, 2)}\n`);
  }

  const scope = scopeFromPlan(plan);
  const extra = {
    unmapped: String(plan.unmapped.length > 0),
    reused: String(reused),
    suite: plan.suite,
    tree: plan.candidate_tree_sha,
    policy_digest: plan.policy_digest,
  };
  const output = formatGitHubOutputs(scope, extra);
  if (args.githubOutput) appendFileSync(args.githubOutput, output);
  if (args.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else process.stdout.write(formatMappingTable(plan));
  process.stderr.write(`CI scope: ${files.length} changed files\n${output}`);

  if (planIsFailing(plan)) process.exit(1);
}

if (import.meta.main) main();
