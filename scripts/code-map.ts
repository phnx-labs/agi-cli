#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py)$/;
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;
const TS_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TS_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']|^import\s+["']([^"']+)["']/gm;
const TS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DSM_CAP = 16;
const DAYS_DEFAULT = 90;
const DEPTH_DEFAULT = 2;
const SCOPE_DEFAULT = 'cli/src';

export type FileRec = {
  path: string;
  loc: number;
  commits: number;
  module: string;
};

export type Edge = { from: string; to: string; count: number };

export type TreemapRect = {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  loc: number;
  commits: number;
  leaf: boolean;
};

export type CodeMap = {
  repoRoot: string;
  scope: string;
  date: string;
  days: number;
  depth: number;
  files: FileRec[];
  loc: number;
  edges: Edge[];
  cycles: string[][];
  similar: { name: string; paths: string[] }[];
  treemap: TreemapRect[];
  maxCommits: number;
};

export type CodeMapArgs = {
  scope: string;
  outDir: string | null;
  days: number;
  depth: number;
};

type TreeNode = {
  name: string;
  path: string;
  loc: number;
  commits: number;
  children: Map<string, TreeNode>;
  leaf: boolean;
};

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }).trim();
}

function locOf(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.trim()) n++;
  }
  return n;
}

export function parseArgs(argv: string[]): CodeMapArgs {
  let scope = SCOPE_DEFAULT;
  let outDir: string | null = null;
  let days = DAYS_DEFAULT;
  let depth = DEPTH_DEFAULT;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outDir = argv[++i] ?? null;
    else if (a === '--days') days = Number(argv[++i]) || DAYS_DEFAULT;
    else if (a === '--depth') depth = Number(argv[++i]) || DEPTH_DEFAULT;
    else if (a === '--help' || a === '-h') {
      rest.push(a);
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`);
    } else rest.push(a);
  }
  if (rest[0] === '--help' || rest[0] === '-h') {
    throw new Error('help');
  }
  if (rest[0]) scope = rest[0];
  return { scope, outDir, days, depth };
}

export function moduleOf(relFile: string, depth: number): string {
  const parts = posix.dirname(relFile).split('/').filter((p) => p && p !== '.');
  return parts.slice(0, depth).join('/') || '(root)';
}

export function resolveTs(fromFile: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const stripped = spec.replace(/\.(?:js|ts|tsx|mjs|cjs)$/, '');
  const base = posix.normalize(posix.join(posix.dirname(fromFile), stripped));
  const cands = [base, ...TS_EXT.map((e) => base + e), ...TS_EXT.map((e) => posix.join(base, 'index' + e))];
  for (const c of cands) {
    const rel = c.replace(/\\/g, '/');
    if (fileSet.has(rel)) return rel;
  }
  return null;
}

export function extractTsSpecs(source: string): string[] {
  const out: string[] = [];
  TS_IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TS_IMPORT.exec(source))) {
    const spec = m[1] || m[2];
    if (spec) out.push(spec);
  }
  return out;
}

export function tarjan(nodes: string[], adj: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onstack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const sccs: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onstack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onstack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onstack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      sccs.push(comp);
    }
  };
  for (const v of nodes) if (!idx.has(v)) strong(v);
  return sccs.filter((c) => c.length > 1);
}

export function groupByBasename(paths: string[]): { name: string; paths: string[] }[] {
  const g = new Map<string, string[]>();
  for (const p of paths) {
    const name = p.split('/').pop() || p;
    const list = g.get(name) ?? [];
    list.push(p);
    g.set(name, list);
  }
  return [...g.entries()]
    .filter(([, ps]) => ps.length >= 2)
    .map(([name, ps]) => ({ name, paths: ps.sort() }))
    .sort((a, b) => b.paths.length - a.paths.length || a.name.localeCompare(b.name));
}

function insertTree(root: TreeNode, file: FileRec) {
  const parts = file.path.split('/').filter(Boolean);
  let cur = root;
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    acc = acc ? `${acc}/${name}` : name;
    const leaf = i === parts.length - 1;
    let child = cur.children.get(name);
    if (!child) {
      child = { name, path: acc, loc: 0, commits: 0, children: new Map(), leaf };
      cur.children.set(name, child);
    }
    child.loc += file.loc;
    child.commits += file.commits;
    if (leaf) child.leaf = true;
    cur = child;
  }
}

export function layoutTreemap(root: TreeNode, width: number, height: number): TreemapRect[] {
  const out: TreemapRect[] = [];
  const walk = (node: TreeNode, x: number, y: number, w: number, h: number, horiz: boolean) => {
    out.push({
      path: node.path,
      x,
      y,
      w,
      h,
      loc: node.loc,
      commits: node.commits,
      leaf: node.leaf && node.children.size === 0,
    });
    const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (kids.length === 0 || w < 2 || h < 2) return;
    const total = kids.reduce((s, k) => s + Math.max(k.loc, 1), 0);
    let cursor = horiz ? x : y;
    const span = horiz ? w : h;
    for (const kid of kids) {
      const frac = Math.max(kid.loc, 1) / total;
      const size = span * frac;
      if (horiz) walk(kid, cursor, y, size, h, !horiz);
      else walk(kid, x, cursor, w, size, !horiz);
      cursor += size;
    }
  };
  walk(root, 0, 0, width, height, width >= height);
  return out;
}

function heat(commits: number, maxCommits: number): string {
  if (maxCommits <= 0 || commits <= 0) return '#1a2420';
  const t = Math.min(1, commits / maxCommits);
  const r = Math.round(26 + t * (213 - 26));
  const g = Math.round(36 + t * (94 - 36));
  const b = Math.round(32 + t * (0 - 32));
  return `rgb(${r},${g},${b})`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildMap(opts: {
  repoRoot: string;
  scope: string;
  days?: number;
  depth?: number;
  date?: string;
}): CodeMap {
  const repoRoot = opts.repoRoot;
  const scope = opts.scope.replace(/\/$/, '') || '.';
  const days = opts.days ?? DAYS_DEFAULT;
  const depth = opts.depth ?? DEPTH_DEFAULT;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const tracked = git(repoRoot, ['ls-files', '--', scope]).split('\n').filter(Boolean);
  const rels = tracked
    .map((f) => (scope === '.' ? f : f.startsWith(`${scope}/`) ? f.slice(scope.length + 1) : f === scope ? '' : f))
    .filter((rel, i) => {
      const full = tracked[i];
      return SOURCE_RE.test(full) && !TEST_RE.test(full) && rel !== '';
    });
  const fullOf = new Map<string, string>();
  for (let i = 0; i < tracked.length; i++) {
    const full = tracked[i];
    if (!SOURCE_RE.test(full) || TEST_RE.test(full)) continue;
    const rel = scope === '.' ? full : full.startsWith(`${scope}/`) ? full.slice(scope.length + 1) : '';
    if (rel) fullOf.set(rel, full);
  }
  const commitCount = new Map<string, number>();
  const log = git(repoRoot, [
    'log',
    `--since=${days} days ago`,
    '--name-only',
    '--pretty=format:',
    '--',
    scope,
  ]);
  for (const line of log.split('\n')) {
    if (!line) continue;
    const rel = scope === '.' ? line : line.startsWith(`${scope}/`) ? line.slice(scope.length + 1) : '';
    if (!rel || !fullOf.has(rel)) continue;
    commitCount.set(rel, (commitCount.get(rel) ?? 0) + 1);
  }
  const files: FileRec[] = [];
  const fileSet = new Set(rels);
  for (const rel of rels) {
    const abs = join(repoRoot, fullOf.get(rel)!);
    let text = '';
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    files.push({
      path: rel,
      loc: locOf(text),
      commits: commitCount.get(rel) ?? 0,
      module: moduleOf(rel, depth),
    });
  }
  files.sort((a, b) => b.loc - a.loc);
  if (files.length === 0) throw new Error(`no source files under ${scope}`);
  const locByPath = new Map(files.map((f) => [f.path, f]));
  const edgeMap = new Map<string, number>();
  const fileAdj = new Map<string, string[]>();
  for (const f of files) {
    if (!TS_RE.test(f.path)) continue;
    const abs = join(repoRoot, fullOf.get(f.path)!);
    let text = '';
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractTsSpecs(text)) {
      const resolved = resolveTs(f.path, spec, fileSet);
      if (!resolved) continue;
      const flist = fileAdj.get(f.path) ?? [];
      if (!flist.includes(resolved)) flist.push(resolved);
      fileAdj.set(f.path, flist);
      const toMod = locByPath.get(resolved)?.module;
      if (!toMod || toMod === f.module) continue;
      const key = `${f.module}\0${toMod}`;
      edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
    }
  }
  const edges: Edge[] = [...edgeMap.entries()].map(([k, count]) => {
    const [from, to] = k.split('\0');
    return { from, to, count };
  });
  const cycles = tarjan(
    files.map((f) => f.path),
    fileAdj,
  );
  const similar = groupByBasename(files.map((f) => f.path));
  const tree: TreeNode = {
    name: scope,
    path: '',
    loc: files.reduce((s, f) => s + f.loc, 0),
    commits: files.reduce((s, f) => s + f.commits, 0),
    children: new Map(),
    leaf: false,
  };
  for (const f of files) insertTree(tree, f);
  const treemap = layoutTreemap(tree, 960, 420);
  const maxCommits = files.reduce((m, f) => Math.max(m, f.commits), 0);
  return {
    repoRoot,
    scope,
    date,
    days,
    depth,
    files,
    loc: tree.loc,
    edges,
    cycles,
    similar,
    treemap,
    maxCommits,
  };
}

function dsmModules(map: CodeMap): string[] {
  const loc = new Map<string, number>();
  for (const f of map.files) loc.set(f.module, (loc.get(f.module) ?? 0) + f.loc);
  const connected = new Set<string>();
  for (const e of map.edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  const ranked = [...loc.entries()]
    .filter(([m]) => connected.has(m) || (loc.get(m) ?? 0) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.slice(0, DSM_CAP).map(([m]) => m);
}

function renderTreemap(map: CodeMap): string {
  const leaves = map.treemap.filter((r) => r.leaf);
  const parts: string[] = [
    `<svg viewBox="0 0 960 420" role="img" aria-label="Path-sorted mass treemap of ${esc(map.scope)}">`,
  ];
  for (const r of leaves) {
    const fill = heat(r.commits, map.maxCommits);
    parts.push(
      `<rect x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" width="${Math.max(r.w, 0.5).toFixed(2)}" height="${Math.max(r.h, 0.5).toFixed(2)}" fill="${fill}" stroke="#0a0a0a" stroke-width="0.6"><title>${esc(r.path)} · ${r.loc} loc · ${r.commits} commits</title></rect>`,
    );
    if (r.w > 64 && r.h > 18) {
      const label = r.path.split('/').pop() || r.path;
      parts.push(
        `<text x="${(r.x + 4).toFixed(2)}" y="${(r.y + 14).toFixed(2)}" fill="#e8e8e8" font-family="ui-monospace, monospace" font-size="10">${esc(label)}</text>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function renderDsm(map: CodeMap): string {
  const mods = dsmModules(map);
  if (mods.length === 0) return '<p class="muted">No module edges in this scope.</p>';
  const n = mods.length;
  const cell = 28;
  const left = 120;
  const top = 28;
  const w = left + n * cell + 8;
  const h = top + n * cell + 8;
  const idx = new Map(mods.map((m, i) => [m, i]));
  const weight = new Map<string, number>();
  const mutual = new Set<string>();
  for (const e of map.edges) {
    if (!idx.has(e.from) || !idx.has(e.to)) continue;
    weight.set(`${e.from}\0${e.to}`, e.count);
  }
  for (const e of map.edges) {
    if (weight.has(`${e.to}\0${e.from}`) && e.from !== e.to) {
      mutual.add(`${e.from}\0${e.to}`);
      mutual.add(`${e.to}\0${e.from}`);
    }
  }
  const parts: string[] = [
    `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Module DSM">`,
  ];
  for (let i = 0; i < n; i++) {
    parts.push(
      `<text x="${left - 6}" y="${top + i * cell + 18}" text-anchor="end" fill="#8a8a8a" font-family="ui-monospace, monospace" font-size="9">${esc(mods[i])}</text>`,
    );
    const col = mods[i].split('/').pop() || mods[i];
    parts.push(
      `<text x="${left + i * cell + 14}" y="16" text-anchor="middle" fill="#8a8a8a" font-family="ui-monospace, monospace" font-size="8">${esc(col.slice(0, 8))}</text>`,
    );
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const key = `${mods[r]}\0${mods[c]}`;
      const count = weight.get(key) ?? 0;
      let fill = '#141414';
      if (r === c) fill = '#1a1a1a';
      else if (mutual.has(key)) fill = '#111111';
      else if (count > 0) fill = '#56B4E9';
      const x = left + c * cell;
      const y = top + r * cell;
      parts.push(
        `<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="${fill}" stroke="#333"><title>${esc(mods[r])} → ${esc(mods[c])}: ${count}</title></rect>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

export function renderHtml(map: CodeMap): string {
  const hot = [...map.files].sort((a, b) => b.commits - a.commits || b.loc - a.loc).slice(0, 25);
  const gods = [...map.files].slice(0, 20);
  const similar = map.similar.slice(0, 24);
  const dirLoc = new Map<string, { files: number; loc: number }>();
  for (const f of map.files) {
    const d = f.path.includes('/') ? f.path.split('/')[0] : '(root)';
    const cur = dirLoc.get(d) ?? { files: 0, loc: 0 };
    cur.files++;
    cur.loc += f.loc;
    dirLoc.set(d, cur);
  }
  const dirs = [...dirLoc.entries()].sort((a, b) => b[1].loc - a[1].loc);
  const cycleBlocks = map.cycles
    .sort((a, b) => b.length - a.length)
    .slice(0, 12)
    .map((c) => {
      if (c.length > 24) {
        const pct = Math.round((100 * c.length) / Math.max(map.files.length, 1));
        return `<li><strong>${c.length} files (${pct}% of scope)</strong> — one strongly connected component. Too coupled to list; the small cycles below are the extractable ones.</li>`;
      }
      const shown = [...c].sort();
      return `<li><strong>${c.length} files</strong> · ${shown
        .map((m) => `<code>${esc(m)}</code>`)
        .join(' · ')}</li>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>code-map · ${esc(map.scope)} · ${esc(map.date)}</title>
<style>
:root{--bg:#0a0a0a;--panel:#141414;--line:#333;--text:#e8e8e8;--muted:#888;--accent:#a3e635;--sky:#56B4E9;--hot:#D55E00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}
header{padding:28px 24px 16px;border-bottom:1px solid var(--line)}
header h1{margin:0 0 8px;font:700 22px/1.2 "JetBrains Mono",ui-monospace,monospace;color:var(--accent)}
.sub{color:var(--muted);font:12px/1.4 ui-monospace,monospace}
nav{display:flex;flex-wrap:wrap;gap:10px;padding:12px 24px;border-bottom:1px solid var(--line);font:12px ui-monospace,monospace}
nav a{color:var(--accent);text-decoration:none}
main{max-width:1080px;margin:0 auto;padding:24px}
section{margin:0 0 40px}
h2{margin:0 0 8px;font:650 16px/1.3 Inter,system-ui,sans-serif}
.muted{color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0 8px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}
.stat b{display:block;font:700 20px/1.2 ui-monospace,monospace;color:var(--accent)}
.stat span{color:var(--muted);font-size:12px}
.figure{background:#0f0f0f;border:1px solid var(--line);border-radius:8px;padding:8px;overflow:auto}
svg{display:block;width:100%;height:auto}
table{width:100%;border-collapse:collapse;font:12px/1.4 ui-monospace,monospace}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font:12px ui-monospace,monospace;margin:8px 0}
.swatch{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:middle}
ul.cycles{padding-left:18px}
ul.cycles code{font-size:12px}
.pair{display:grid;grid-template-columns:140px 1fr;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font:12px ui-monospace,monospace}
footer{color:var(--muted);font:12px ui-monospace,monospace;padding:24px;border-top:1px solid var(--line)}
</style>
</head>
<body>
<header>
  <h1>code-map</h1>
  <div class="sub">${esc(map.scope)} · ${esc(map.date)} · ${map.days}d window · module depth ${map.depth}</div>
</header>
<nav>
  <a href="#mass">mass</a>
  <a href="#hotspots">hotspots</a>
  <a href="#dsm">dsm</a>
  <a href="#cycles">cycles</a>
  <a href="#similar">same-name</a>
  <a href="#gods">largest</a>
</nav>
<main>
  <section class="stats">
    <div class="stat"><b>${map.files.length}</b><span>source files</span></div>
    <div class="stat"><b>${map.loc.toLocaleString()}</b><span>non-blank loc</span></div>
    <div class="stat"><b>${new Set(map.files.map((f) => f.module)).size}</b><span>modules</span></div>
    <div class="stat"><b>${map.edges.length}</b><span>module edges</span></div>
    <div class="stat"><b>${map.cycles.length}</b><span>file cycles ≥2</span></div>
    <div class="stat"><b>${map.similar.length}</b><span>shared basenames</span></div>
  </section>
  <section>
    <h2>Directories</h2>
    <table>
      <thead><tr><th>dir</th><th class="num">files</th><th class="num">loc</th></tr></thead>
      <tbody>
        ${dirs
          .map(
            ([d, v]) =>
              `<tr><td>${esc(d)}</td><td class="num">${v.files}</td><td class="num">${v.loc.toLocaleString()}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </section>
  <section id="mass">
    <h2>Mass treemap</h2>
    <p class="muted">Area = non-blank loc. Color = commits in the last ${map.days} days. Path-sorted so layout stays stable.</p>
    <div class="legend"><span><i class="swatch" style="background:#1a2420"></i>cold</span><span><i class="swatch" style="background:#D55E00"></i>hot</span></div>
    <div class="figure">${renderTreemap(map)}</div>
  </section>
  <section id="hotspots">
    <h2>Hotspots</h2>
    <p class="muted">Files with the most commits in ${map.days} days. Size is loc, not a quality score.</p>
    <table>
      <thead><tr><th>file</th><th class="num">commits</th><th class="num">loc</th><th>module</th></tr></thead>
      <tbody>
        ${hot
          .map(
            (f) =>
              `<tr><td>${esc(f.path)}</td><td class="num">${f.commits}</td><td class="num">${f.loc}</td><td>${esc(f.module)}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </section>
  <section id="dsm">
    <h2>Layered DSM</h2>
    <p class="muted">Top ${DSM_CAP} modules by loc. Sky = uses. Black = mutual / cycle. Hover a cell for the import count.</p>
    <div class="figure">${renderDsm(map)}</div>
  </section>
  <section id="cycles">
    <h2>Cycle extractor</h2>
    <p class="muted">Strongly connected components of size ≥ 2 on the relative-import graph.</p>
    ${map.cycles.length ? `<ul class="cycles">${cycleBlocks}</ul>` : '<p class="muted">No import cycles in this scope.</p>'}
  </section>
  <section id="similar">
    <h2>Same-name families</h2>
    <p class="muted">Files that share a basename in different folders — the cheap dual-tree. Extract only when they encode the same decision.</p>
    ${
      similar.length === 0
        ? '<p class="muted">No shared basenames.</p>'
        : similar
            .map(
              (s) =>
                `<div class="pair"><div>${esc(s.name)} · ${s.paths.length}</div><div>${s.paths.map((p) => esc(p)).join('<br/>')}</div></div>`,
            )
            .join('')
    }
  </section>
  <section id="gods">
    <h2>Largest files</h2>
    <table>
      <thead><tr><th>file</th><th class="num">loc</th><th class="num">commits</th></tr></thead>
      <tbody>
        ${gods
          .map(
            (f) =>
              `<tr><td>${esc(f.path)}</td><td class="num">${f.loc}</td><td class="num">${f.commits}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </section>
</main>
<footer>
  bun scripts/code-map.ts ${esc(map.scope)} --days ${map.days} --depth ${map.depth}<br/>
  writes reports/${esc(map.date)}/index.html
</footer>
</body>
</html>
`;
}

export function reportDir(repoRoot: string, date: string, outDir: string | null): string {
  if (outDir) return resolve(repoRoot, outDir);
  return join(repoRoot, 'reports', date);
}

export function writeReport(map: CodeMap, outDir: string | null): { html: string; json: string } {
  const dir = reportDir(map.repoRoot, map.date, outDir);
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, 'index.html');
  const jsonPath = join(dir, 'map.json');
  writeFileSync(htmlPath, renderHtml(map));
  const json = {
    scope: map.scope,
    date: map.date,
    days: map.days,
    depth: map.depth,
    files: map.files.length,
    loc: map.loc,
    edges: map.edges,
    cycles: map.cycles,
    similar: map.similar,
    hotspots: [...map.files].sort((a, b) => b.commits - a.commits).slice(0, 50),
  };
  writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  return { html: htmlPath, json: jsonPath };
}

export function run(argv: string[], repoRoot: string): { html: string; json: string } {
  let args: CodeMapArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof Error && err.message === 'help') {
      process.stderr.write(
        'usage: bun scripts/code-map.ts [scope] [--out dir] [--days 90] [--depth 2]\n',
      );
      process.exit(0);
    }
    throw err;
  }
  const map = buildMap({
    repoRoot,
    scope: args.scope,
    days: args.days,
    depth: args.depth,
  });
  return writeReport(map, args.outDir);
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === pathToFileURL(thisFile).href) {
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const { html, json } = run(process.argv.slice(2), repoRoot);
  process.stdout.write(`${html}\n${json}\n`);
}
