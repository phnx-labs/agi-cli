// Exercises the real command tree (no mocks) so a Commander upgrade that renames
// the introspection API (`registeredArguments`, `.aliases()`, `.options`) — or a
// command that stops registering — fails here instead of silently producing an
// empty/wrong index.

import { describe, expect, it } from 'vitest';
import { buildFullCommandTree } from '../src/cli/command-registry.js';
import {
  argToken,
  auditReference,
  countCommands,
  invocation,
  renderJson,
  renderHtml,
  renderMarkdown,
  rootNode,
  walk,
  type CommandNode,
} from './gen-command-index';

async function tree(): Promise<CommandNode[]> {
  return walk(await buildFullCommandTree());
}

function find(nodes: CommandNode[], path: string): CommandNode | undefined {
  const parts = path.split(' ');
  let level = nodes;
  let node: CommandNode | undefined;
  for (const part of parts) {
    node = level.find((n) => n.name === part);
    if (!node) return undefined;
    level = node.subcommands;
  }
  return node;
}

describe('argToken', () => {
  it('renders required/optional/variadic usage tokens', () => {
    expect(argToken({ name: 'id', required: true, variadic: false })).toBe('<id>');
    expect(argToken({ name: 'query', required: false, variadic: false })).toBe('[query]');
    expect(argToken({ name: 'specs', required: true, variadic: true })).toBe('<specs...>');
    expect(argToken({ name: 'rest', required: false, variadic: true })).toBe('[rest...]');
  });
});

describe('command index generation', () => {
  it('builds a non-trivial tree from the real command modules', async () => {
    const nodes = await tree();
    expect(nodes.length).toBeGreaterThan(50); // the whole tree really loaded
    expect(countCommands(nodes)).toBeGreaterThan(nodes.length); // groups have subcommands
  });

  it('has descriptions for every visible command and option', async () => {
    expect(auditReference(await tree())).toEqual([]);
  });

  it('captures a nested command with its required argument (teams create <team>)', async () => {
    const nodes = await tree();
    const create = find(nodes, 'teams create');
    expect(create).toBeDefined();
    expect(create!.args).toContainEqual({ name: 'team', required: true, variadic: false, description: '' });
    expect(invocation(create!)).toBe('teams create <team>');
    expect(create!.description.length).toBeGreaterThan(0);
  });

  it('records commander aliases without duplicating the group (devices/fleet)', async () => {
    const nodes = await tree();
    // `fleet` is an alias of `devices`, so it must NOT appear as its own group.
    expect(nodes.filter((n) => n.name === 'fleet')).toHaveLength(0);
    expect(find(nodes, 'devices')?.aliases).toContain('fleet');
  });

  it('excludes the inline aliases/tombstones registered in src/index.ts', async () => {
    const nodes = await tree();
    const names = new Set(nodes.map((n) => n.name));
    for (const inline of ['perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', '_internal']) {
      expect(names.has(inline)).toBe(false);
    }
  });

  it('includes the visible upgrade command registered by the live CLI entry point', async () => {
    const upgrade = find(await tree(), 'upgrade');
    expect(upgrade).toBeDefined();
    expect(invocation(upgrade!)).toBe('upgrade [version]');
    expect(upgrade!.options.map((option) => option.flags)).toContain('-y, --yes');
  });

  it('captures the root agents metadata and global options', async () => {
    const root = rootNode(await buildFullCommandTree());
    expect(root.name).toBe('agents');
    expect(root.description).toContain('Install, configure, run, and dispatch AI coding agents');
    expect(root.options.map((option) => option.long)).toContain('--version');
    expect(root.options.map((option) => option.long)).toContain('--verbose');
    expect(root.options.map((option) => option.long)).toContain('--help');
  });

  it('captures option flags in the JSON tree', async () => {
    const nodes = await tree();
    const json = JSON.parse(renderJson(nodes)) as { tree: CommandNode[] };
    const create = find(json.tree, 'teams create');
    expect(create).toBeDefined();
    // Every option is a {flags, description} pair, never a bare string.
    for (const opt of create!.options) {
      expect(typeof opt.flags).toBe('string');
      expect(opt.flags.length).toBeGreaterThan(0);
      expect(typeof opt.required).toBe('boolean');
      expect(typeof opt.optional).toBe('boolean');
      expect(typeof opt.variadic).toBe('boolean');
    }
  });

  it('captures nested option variants, choices, defaults, examples, and notes', async () => {
    const nodes = await tree();
    // `insights query` is a nested command that redeclares its flags (unlike the
    // opaque `browser start` passthrough, PHNX-4101), so it exercises the generator's
    // capture of nested long options AND their defaults.
    const query = find(nodes, 'insights query');
    expect(query).toBeDefined();
    expect(query!.options.some((option) => option.long?.startsWith('--'))).toBe(true);
    expect(query!.options.some((option) => option.defaultValue !== undefined)).toBe(true);
    const tmux = find(nodes, 'tmux');
    expect(tmux?.examples).toContain('agents tmux');
    expect(tmux?.notes?.length).toBeGreaterThan(0);
  });

  it('renders scannable Markdown with a fenced block per group', async () => {
    const nodes = await tree();
    const md = renderMarkdown(nodes);
    expect(md).toContain('# Command index');
    expect(md).toContain('## teams');
    expect(md).toContain('agents teams create <team>');
    // Fenced code blocks are balanced (one open + close per group).
    expect((md.match(/^```$/gm) ?? []).length).toBe(nodes.length * 2);
  });

  it('renders a searchable standalone HTML reference for every command', async () => {
    const nodes = await tree();
    const html = renderHtml(nodes);
    expect(html).toContain('type="search"');
    expect(html).toContain('agents teams create &lt;team&gt;');
    expect((html.match(/<article /g) ?? []).length).toBe(countCommands(nodes));
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=/);
  });

  it('renders a navigable tree with one entry per command card', async () => {
    const nodes = await tree();
    const html = renderHtml(nodes);
    expect(html).toContain('<nav id="nav"');
    // Every card is reachable by browsing, not only by searching.
    expect((html.match(/<li data-nav=/g) ?? []).length).toBe(countCommands(nodes));
    // A group with subcommands is collapsible; its children nest under it.
    expect(html).toContain('<li data-nav="teams"><details><summary><a href="#teams">teams</a>');
    expect(html).toContain('<li data-nav="teams-create"><a href="#teams-create">create</a></li>');
  });

  it('anchors every nav link to a card that exists, including the root node', async () => {
    const program = await buildFullCommandTree();
    const nodes = walk(program);
    const html = renderHtml(nodes, rootNode(program));
    const ids = new Set([...html.matchAll(/<article id="([^"]*)"/g)].map((m) => m[1]));
    const targets = [...html.matchAll(/<li data-nav="([^"]*)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(ids.has(target)).toBe(true);
    // The root's path is empty; it must still be linkable rather than id="".
    expect(ids.has('agents')).toBe(true);
    expect(html).not.toContain('id=""');
  });

  it('keeps the reserved root anchor free of collisions', async () => {
    // nodeId() hands the root the reserved id `agents` because its path is
    // empty. That is only safe while no top-level group is named `agents` — a
    // group by that name would mean `agents agents` and silently steal the
    // root's anchor. Enforce the claim the comment makes instead of trusting it.
    const nodes = await tree();
    expect(nodes.map((node) => node.name)).not.toContain('agents');
    const html = renderHtml(nodes, rootNode(await buildFullCommandTree()));
    const ids = [...html.matchAll(/<article id="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
