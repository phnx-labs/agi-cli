// Generate the full command index for the `agents` CLI — every command and
// subcommand with its argument names and one-line description, in two forms:
//
//   docs/command-index.md    a grouped, human-scannable index (arg tokens + summary)
//   docs/command-index.json  the canonical, structured API surface
//   docs/command-reference.html  a self-contained searchable reference
//
// Both are GENERATED artifacts — never hand-edit them. Run `npm run gen:index`
// (or `bun scripts/gen-command-index.ts`); release.sh regenerates them so the
// committed index always matches the shipped command surface. `npm run verify:index`
// (scripts/verify-command-index.sh, run in CI's cli-preflight + cli-docs jobs)
// fails if the committed files are stale.
//
// The source of truth is the CLI's own lazy loader table: `buildFullCommandTree`
// registers every module in `COMMAND_LOADERS` onto a throwaway program and hands
// back the real Commander tree, so this cannot drift from what the CLI registers.
// The introspection is deterministic — no LLM, no help-text parsing.
//
// Excluded by design: the inline deprecated aliases and tombstones
// (`perms`/`exec`/`jobs`/`cron`/`check`/`resources`/`hq`/`_internal`),
// which src/index.ts registers directly as closures over entry-point state.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { getHelpSections } from '../src/lib/help.js';
import { buildFullCommandTree } from '../src/cli/command-registry.js';

export interface CommandArg {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
  defaultValue?: unknown;
  choices?: string[];
}

export interface CommandOption {
  flags: string;
  description: string;
  short?: string;
  long?: string;
  required: boolean;
  optional: boolean;
  variadic: boolean;
  negate: boolean;
  defaultValue?: unknown;
  defaultValueDescription?: string;
  choices?: string[];
  environmentVariable?: string;
}

export interface CommandNode {
  name: string;
  path: string; // full invocation path after `agents `, e.g. "teams create"
  aliases: string[];
  description: string;
  args: CommandArg[];
  options: CommandOption[];
  examples?: string;
  notes?: string;
  subcommands: CommandNode[];
}

/** Reconstruct the usage token for an argument: `<a>`, `[a]`, `<a...>`, `[a...]`. */
export function argToken(a: CommandArg): string {
  const inner = a.variadic ? `${a.name}...` : a.name;
  return a.required ? `<${inner}>` : `[${inner}]`;
}

/** The `path arg1 arg2` invocation string (without the leading `agents `). */
export function invocation(node: CommandNode): string {
  return [node.path, ...node.args.map(argToken)].join(' ');
}

/**
 * Commander marks hidden subcommands/options with an internal `_hidden` flag and
 * exposes no public getter. The field has been stable across the commander 12.x
 * and 15.x line the CLI has used; `gen-command-index.test.ts` pins the shape.
 */
function isHidden(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

/**
 * Deterministic, locale-independent name sort. `localeCompare` orders by the
 * platform's ICU, which differs between macOS (dev) and Linux (CI) — it reordered
 * the committed index and the CI gate caught the drift. UTF-16 codepoint order
 * (`<`/`>`) is identical on every platform.
 */
function byName(a: Command, b: Command): number {
  const x = a.name();
  const y = b.name();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Convert one Commander command (and its whole subtree) into a plain CommandNode. */
export function toNode(cmd: Command, parentPath: string): CommandNode {
  const name = cmd.name();
  const path = parentPath ? `${parentPath} ${name}` : name;
  const args: CommandArg[] = cmd.registeredArguments
    .filter((a) => (a as unknown as { hidden?: boolean }).hidden !== true)
    .map((a) => ({
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    description: (a.description ?? '').trim(),
    ...(a.defaultValue === undefined ? {} : { defaultValue: a.defaultValue }),
    ...(a.argChoices === undefined ? {} : { choices: [...a.argChoices] }),
    }));
  const options: CommandOption[] = cmd.createHelp().visibleOptions(cmd)
    .filter((o) => !o.hidden)
    .map((o) => ({
      flags: o.flags,
      description: (o.description ?? '').trim(),
      ...(o.short === undefined ? {} : { short: o.short }),
      ...(o.long === undefined ? {} : { long: o.long }),
      required: o.required,
      optional: o.optional,
      variadic: o.variadic,
      negate: o.negate,
      ...(o.defaultValue === undefined ? {} : { defaultValue: o.defaultValue }),
      ...(o.defaultValueDescription === undefined ? {} : { defaultValueDescription: o.defaultValueDescription }),
      ...(o.argChoices === undefined ? {} : { choices: [...o.argChoices] }),
      ...(o.envVar === undefined ? {} : { environmentVariable: o.envVar }),
    }));
  const subcommands = cmd.commands
    .filter((c) => !isHidden(c))
    .sort(byName)
    .map((c) => toNode(c, path));
  // Commander's summary() is the short one-liner when set; fall back to description().
  const summary = typeof cmd.summary === 'function' ? cmd.summary() : '';
  const sections = getHelpSections(cmd);
  return {
    name,
    path,
    aliases: cmd.aliases(),
    description: (summary || cmd.description() || '').trim(),
    args,
    options,
    ...(sections.examples ? { examples: sections.examples.trim() } : {}),
    ...(sections.notes ? { notes: sections.notes.trim() } : {}),
    subcommands,
  };
}

/** Build the sorted top-level node list from a fully-registered program. */
export function walk(program: Command): CommandNode[] {
  return program.commands
    .filter((c) => !isHidden(c))
    .sort(byName)
    .map((c) => toNode(c, ''));
}

/** Root `agents` metadata and global options, without duplicating its child tree. */
export function rootNode(program: Command): CommandNode {
  const root = toNode(program, '');
  return { ...root, path: '', subcommands: [] };
}

/** Depth-first flatten of a node subtree into scannable index rows. */
function* rows(node: CommandNode): Generator<{ invocation: string; description: string }> {
  yield { invocation: invocation(node), description: node.description };
  for (const sub of node.subcommands) yield* rows(sub);
}

/** Total command count (group roots + every subcommand) across the tree. */
export function countCommands(nodes: CommandNode[]): number {
  return nodes.reduce((n, node) => n + [...rows(node)].length, 0);
}

export interface ReferenceIssue {
  path: string;
  field: 'description' | 'option-description';
  detail: string;
}

/** Missing public help metadata that would leave a reference entry ambiguous. */
export function auditReference(nodes: CommandNode[]): ReferenceIssue[] {
  return flatten(nodes).flatMap((node) => [
    ...(node.description ? [] : [{ path: node.path, field: 'description' as const, detail: 'command has no description' }]),
    ...node.options
      .filter((option) => !option.description)
      .map((option) => ({ path: node.path, field: 'option-description' as const, detail: `${option.flags} has no description` })),
  ]);
}

const MD_HEADER = `<!-- GENERATED by scripts/gen-command-index.ts — DO NOT EDIT. Run \`npm run gen:index\`. -->

# Command index

Every \`agents\` command and subcommand, with its argument names and one-line
description. Generated from the CLI's own command tree, so it never drifts from
what \`agents\` actually registers.

- Regenerate: \`npm run gen:index\` (from \`cli\`), or it is rebuilt on release.
- Full option lists live in the machine-readable [\`command-index.json\`](command-index.json).
- \`agents <group> --help\` shows the workflow-first help (examples + notes) for a group.

Excluded (same as \`agents --help --all\`): commands Commander marks hidden (e.g. \`remove\`/\`rm\`/\`purge\`
and internal subcommands), plus the deprecated aliases and tombstones registered inline in
src/index.ts (\`perms\`, \`exec\`, \`jobs\`, \`cron\`, \`check\`, \`resources\`, \`hq\`, \`_internal\`).
`;

/** Render the grouped, human-scannable Markdown index. */
export function renderMarkdown(nodes: CommandNode[]): string {
  const lines: string[] = [MD_HEADER, `_${nodes.length} command groups · ${countCommands(nodes)} commands._\n`];
  for (const group of nodes) {
    const heading = group.description ? `## ${group.name} — ${group.description}` : `## ${group.name}`;
    lines.push(heading);
    if (group.aliases.length > 0) lines.push(`_aliases: ${group.aliases.join(', ')}_`);
    lines.push('');
    lines.push('```');
    const groupRows = [...rows(group)];
    const width = Math.min(Math.max(...groupRows.map((r) => r.invocation.length)) + 2, 52);
    for (const r of groupRows) {
      const inv = `agents ${r.invocation}`;
      const pad = ' '.repeat(Math.max(1, width - r.invocation.length));
      lines.push(r.description ? `${inv}${pad}${r.description}` : inv);
    }
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/** Render the structured JSON tree (full option lists included). */
export function renderJson(nodes: CommandNode[], root?: CommandNode): string {
  return JSON.stringify({ schemaVersion: 1, command: 'agents', groups: nodes.length, commands: countCommands(nodes), ...(root ? { root } : {}), tree: nodes }, null, 2) + '\n';
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function detailRows(node: CommandNode): string {
  const args = node.args.map((arg) => `<tr><td><code>${escapeHtml(argToken(arg))}</code></td><td>${escapeHtml(arg.description || '—')}</td><td>${escapeHtml(arg.choices?.join(', ') ?? '')}</td><td>${escapeHtml(arg.defaultValue ?? '')}</td></tr>`).join('');
  const options = node.options.map((option) => `<tr><td><code>${escapeHtml(option.flags)}</code></td><td>${escapeHtml(option.description || '—')}</td><td>${escapeHtml(option.choices?.join(', ') ?? '')}</td><td>${escapeHtml(option.defaultValueDescription ?? option.defaultValue ?? '')}</td></tr>`).join('');
  return `${args ? `<h4>Arguments</h4><table><thead><tr><th>Argument</th><th>Description</th><th>Choices</th><th>Default</th></tr></thead><tbody>${args}</tbody></table>` : ''}${options ? `<h4>Options</h4><table><thead><tr><th>Flags</th><th>Description</th><th>Choices</th><th>Default</th></tr></thead><tbody>${options}</tbody></table>` : ''}`;
}

function flatten(nodes: CommandNode[]): CommandNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.subcommands)]);
}

/**
 * Anchor id for a command card, shared by the card and its nav entry. The root
 * node's path is empty (`rootNode` clears it), which would emit `id=""` and be
 * unlinkable — it takes the reserved `agents` id instead. No group can collide:
 * a top-level group named `agents` would mean `agents agents`.
 */
function nodeId(node: CommandNode): string {
  return node.path ? node.path.replaceAll(' ', '-') : 'agents';
}

/**
 * The navigable tree in the sidebar: one entry per command, groups collapsed by
 * default so 104 groups stay scannable. A group with subcommands renders as a
 * `<details>` so expansion needs no JavaScript; search then drives `open` to
 * reveal matches.
 */
function navTree(nodes: CommandNode[], root?: CommandNode): string {
  const item = (node: CommandNode): string => {
    const id = nodeId(node);
    const link = `<a href="#${escapeHtml(id)}">${escapeHtml(node.name)}</a>`;
    if (node.subcommands.length === 0) return `<li data-nav="${escapeHtml(id)}">${link}</li>`;
    const count = countCommands([node]) - 1;
    return `<li data-nav="${escapeHtml(id)}"><details><summary>${link}<span class="n">${count}</span></summary><ul>${node.subcommands.map(item).join('')}</ul></details></li>`;
  };
  const rootItem = root ? `<li data-nav="${escapeHtml(nodeId(root))}"><a href="#${escapeHtml(nodeId(root))}">agents</a></li>` : '';
  return `<ul class="tree">${rootItem}${nodes.map(item).join('')}</ul>`;
}

/**
 * Render a standalone, dependency-free reference: a navigable command tree in a
 * sticky sidebar plus instant client-side search over every card. Search filters
 * the tree alongside the cards, so a match is reachable by browsing or by typing.
 */
export function renderHtml(nodes: CommandNode[], root?: CommandNode): string {
  const commands = [...(root ? [root] : []), ...flatten(nodes)];
  const nav = navTree(nodes, root);
  const cards = commands.map((node) => {
    const search = [node.name, node.path, node.aliases.join(' '), node.description, ...node.args.map((a) => `${a.name} ${a.description}`), ...node.options.map((o) => `${o.flags} ${o.description}`), node.examples ?? '', node.notes ?? ''].join(' ').toLowerCase();
    const aliases = node.aliases.length ? `<span class="meta">Aliases: ${escapeHtml(node.aliases.join(', '))}</span>` : '';
    const commandLine = node.path ? `agents ${invocation(node)}` : 'agents';
    return `<article id="${escapeHtml(nodeId(node))}" data-search="${escapeHtml(search)}"><div class="command-head"><h3><code>${escapeHtml(commandLine)}</code></h3>${aliases}</div><p>${escapeHtml(node.description || 'No description provided.')}</p>${detailRows(node)}${node.examples ? `<h4>Examples</h4><pre><code>${escapeHtml(node.examples)}</code></pre>` : ''}${node.notes ? `<h4>Notes</h4><p class="notes">${escapeHtml(node.notes)}</p>` : ''}</article>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>agents CLI command reference</title>
<style>:root{color-scheme:dark light;--bg:#0a0a0a;--panel:#151515;--text:#f5f5f5;--muted:#a3a3a3;--line:#303030;--accent:#a3e635;--header-h:158px}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 Inter,system-ui,sans-serif}header{position:sticky;top:0;z-index:3;padding:24px max(24px,calc((100vw - 1480px)/2));background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}h1{margin:0 0 4px;font-size:28px}header p{margin:0;color:var(--muted)}input{width:100%;margin-top:16px;padding:13px 16px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);font:inherit}.shell{display:grid;grid-template-columns:288px minmax(0,1fr);gap:36px;max-width:1480px;margin:auto;padding:0 max(24px,calc((100vw - 1480px)/2))}nav{position:sticky;top:var(--header-h);align-self:start;max-height:calc(100vh - var(--header-h) - 16px);overflow:auto;padding:24px 8px 60px 0;font-size:14px}nav ul{margin:0;padding:0;list-style:none}nav .tree>li>details>summary,nav .tree>li>a{font-weight:500}nav li[hidden]{display:none}nav ul ul{margin-left:10px;padding-left:11px;border-left:1px solid var(--line)}nav a{display:inline-block;padding:3px 6px;border-radius:5px;color:var(--muted);text-decoration:none;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px}nav li>a{margin-left:14px}nav a:hover{color:var(--text);background:var(--panel)}nav a.active{color:var(--bg);background:var(--accent)}nav summary{display:flex;align-items:center;gap:4px;cursor:pointer;list-style:none;border-radius:5px}nav summary::-webkit-details-marker{display:none}nav summary::before{content:"";flex:none;width:0;height:0;margin-left:2px;border:4px solid transparent;border-left-color:var(--muted);transition:transform .12s}nav details[open]>summary::before{transform:rotate(90deg) translateX(-1px)}nav .n{margin-left:auto;padding-right:4px;color:var(--muted);font-size:11px;opacity:.6}#navtoggle{display:none;margin-top:12px;padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);font:inherit;cursor:pointer}main{min-width:0;padding:28px 0 80px}.count{color:var(--accent);font-family:ui-monospace,monospace}article{scroll-margin-top:calc(var(--header-h) + 12px);margin:0 0 16px;padding:22px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}article[hidden]{display:none}.command-head{display:flex;gap:16px;align-items:baseline;justify-content:space-between}h3{margin:0;font-size:18px}h4{margin:20px 0 8px;color:var(--accent);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.meta,.notes,article>p{color:var(--muted)}code,pre{font-family:"JetBrains Mono",ui-monospace,monospace}pre{overflow:auto;padding:14px;border-radius:6px;background:var(--bg)}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}.empty{display:none;padding:22px;color:var(--muted)}.empty.on{display:block}@media(prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#fff;--text:#171717;--muted:#606060;--line:#ddd;--accent:#4d7c0f}}@media(max-width:980px){#navtoggle{display:block}.shell{display:block}nav{position:static;max-height:none;overflow:visible;padding:16px 0 0;border-bottom:1px solid var(--line)}body:not(.nav-open) nav{display:none}}@media(max-width:700px){.command-head{display:block}.meta{display:block;margin-top:6px}table{display:block;overflow:auto}}</style></head>
<body><header><h1>agents CLI command reference</h1><p><span class="count" id="count">${commands.length}</span> commands across ${nodes.length} groups · generated from the registered Commander tree</p><input id="search" type="search" autofocus placeholder="Search commands, flags, arguments, examples, and notes… (press /)" aria-label="Search command reference"><button id="navtoggle" type="button" aria-expanded="false">Browse commands</button></header>
<div class="shell"><nav id="nav" aria-label="Command tree">${nav}</nav><main>${cards}<p class="empty" id="empty">No command matches that search.</p></main></div>
<script>const input=document.querySelector('#search');const nav=document.querySelector('#nav');const cards=[...document.querySelectorAll('article')];const navItems=[...nav.querySelectorAll('li[data-nav]')];const links=new Map([...nav.querySelectorAll('a')].map(a=>[a.getAttribute('href').slice(1),a]));const count=document.querySelector('#count');const empty=document.querySelector('#empty');
function search(){const terms=input.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);const shown=new Set();for(const card of cards){const ok=terms.every(term=>card.dataset.search.includes(term));card.hidden=!ok;if(ok)shown.add(card.id)}count.textContent=shown.size;empty.classList.toggle('on',shown.size===0);
for(let i=navItems.length-1;i>=0;i--){const li=navItems[i];const self=shown.has(li.dataset.nav);const kid=!!li.querySelector('li[data-nav]:not([hidden])');li.hidden=!(self||kid);const d=li.querySelector(':scope > details');if(d)d.open=terms.length?kid:false}}
input.addEventListener('input',search);
function reveal(id){const a=links.get(id);if(!a)return;for(const d of[...document.querySelectorAll('#nav details')])if(d.contains(a))d.open=true;for(const other of links.values())other.classList.remove('active');a.classList.add('active');a.scrollIntoView({block:'nearest'})}
nav.addEventListener('click',e=>{const a=e.target.closest('summary > a');if(!a)return;e.preventDefault();a.closest('details').open=true;location.hash=a.getAttribute('href')});
addEventListener('hashchange',()=>reveal(decodeURIComponent(location.hash.slice(1))));
document.querySelector('#navtoggle').addEventListener('click',e=>{const on=document.body.classList.toggle('nav-open');e.target.setAttribute('aria-expanded',String(on))});
addEventListener('keydown',e=>{if(e.key==='/'&&e.target!==input){e.preventDefault();input.focus()}});
const io=new IntersectionObserver(entries=>{const hit=entries.filter(en=>en.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top)[0];if(hit)reveal(hit.target.id)},{rootMargin:'-'+(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-h'))+10)+'px 0px -72% 0px'});
for(const card of cards)io.observe(card);
if(location.hash)reveal(decodeURIComponent(location.hash.slice(1)));</script></body></html>\n`;
}

// CLI entry — only when executed directly (bun sets import.meta.main; under
// vitest/node it is falsy, so importing the pure helpers has no side effect).
// GEN_COMMAND_INDEX_OUT_DIR overrides the output dir (verify-command-index.sh
// regenerates into a temp dir to diff against the committed files); defaults to ./docs.
if ((import.meta as { main?: boolean }).main) {
  const program = await buildFullCommandTree();
  const nodes = walk(program);
  const root = rootNode(program);
  const issues = auditReference(nodes);
  if (issues.length > 0) {
    throw new Error(`Command reference is incomplete:\n${issues.map((issue) => `- agents ${issue.path}: ${issue.detail}`).join('\n')}`);
  }
  const outDir = process.env.GEN_COMMAND_INDEX_OUT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  writeFileSync(join(outDir, 'command-index.md'), renderMarkdown(nodes));
  writeFileSync(join(outDir, 'command-index.json'), renderJson(nodes, root));
  writeFileSync(join(outDir, 'command-reference.html'), renderHtml(nodes, root));
  console.log(`gen-command-index: wrote command-index.{md,json} and command-reference.html to ${outDir} (${nodes.length} groups, ${countCommands(nodes)} commands)`);
}
