import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRepoTarget,
  collectRepoKind,
  repoManifestSummary,
  repoGitInfo,
  pathSize,
  summarizeHook,
  summarizeMcp,
  hookManifestByScript,
  hookManifestFromFile,
  previewFor,
  wrapJoined,
  summaryLine,
  collectRepoRoutines,
  routineFireLabel,
  routineTargetLabel,
  routineDescription,
  routineHealthTier,
  routineDarkWarning,
  compactAge,
  type RoutineLiveState,
} from './inspect.js';
import { stripAnsi } from '../lib/session/width.js';
import { listHookEntriesFromDir } from '../lib/hooks/install.js';
import type { ManifestHook } from '../lib/types.js';
import { getUserAgentsDir, getSystemAgentsDir } from '../lib/state.js';
import { stringWidth } from '../lib/session/width.js';

const tempDirs: string[] = [];

/** A fake project repo: <root>/.agents/ with commands + a skill bundle. */
function makeProjectRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inspect-'));
  tempDirs.push(root);
  const agentsDir = path.join(root, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'commands', 'ship.md'),
    '---\ndescription: Ship the thing\n---\n\nShip it.\n',
  );
  fs.writeFileSync(path.join(agentsDir, 'commands', 'plain.md'), '# Plain command\n\nbody\n');
  const skillDir = path.join(agentsDir, 'skills', 'deploy');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy services\n---\n\nSteps.\n',
  );
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRepoTarget', () => {
  it('maps the built-in layer names to their roots', () => {
    expect(resolveRepoTarget('user')).toEqual({ label: 'user', root: getUserAgentsDir() });
    expect(resolveRepoTarget('system')).toEqual({ label: 'system', root: getSystemAgentsDir() });
  });

  it('accepts a repo path and descends into its .agents/ dir', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget(root);
    expect(resolved).toEqual({ label: path.basename(root), root: path.join(root, '.agents') });
  });

  it('accepts a DotAgents root directly and labels it by parent dir', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget(path.join(root, '.agents'));
    expect(resolved).toEqual({ label: path.basename(root), root: path.join(root, '.agents') });
  });

  it('resolves relative paths against the provided cwd', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget('.agents', root);
    expect(resolved?.root).toBe(path.join(root, '.agents'));
  });

  it('rejects directories with no DotAgents markers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inspect-empty-'));
    tempDirs.push(dir);
    expect(resolveRepoTarget(dir)).toBeNull();
  });

  it('rejects targets that are not directories', () => {
    expect(resolveRepoTarget('definitely-not-a-repo-or-agent')).toBeNull();
  });
});

describe('collectRepoKind', () => {
  it('lists files with extension stripped and frontmatter descriptions', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;

    const commands = collectRepoKind(repo, 'commands');
    expect(commands.map(c => c.name)).toEqual(['plain', 'ship']);
    const ship = commands.find(c => c.name === 'ship')!;
    expect(ship.description).toBe('Ship the thing');
    expect(ship.source).toBe(repo.label);
    const plain = commands.find(c => c.name === 'plain')!;
    expect(plain.description).toBe('Plain command');
  });

  it('lists skill bundles and links to their SKILL.md', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;

    const skills = collectRepoKind(repo, 'skills');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('deploy');
    expect(skills[0].description).toBe('Deploy services');
    expect(skills[0].linkTarget).toBe(path.join(root, '.agents', 'skills', 'deploy', 'SKILL.md'));
  });

  it('returns empty for kinds with no directory', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;
    expect(collectRepoKind(repo, 'workflows')).toEqual([]);
  });

  it('keeps the first-line description for non-Markdown resources', () => {
    // Guarding the shebang inside readFirstProseLine was the wrong layer: it is shared by every
    // kind, and readResourceDir lists .yaml/.yml/.toml/.json too. A `# comment` on line 1 of an
    // mcp yaml is a real description and must survive.
    const root = makeProjectRepo();
    const mcpDir = path.join(root, '.agents', 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'linear.yaml'), '# Linear issue tracker over http\nurl: https://x\n');
    const repo = resolveRepoTarget(root)!;
    const linear = collectRepoKind(repo, 'mcp').find(m => m.name === 'linear')!;
    expect(linear.description).toBe('Linear issue tracker over http');

    // Markdown resources keep their frontmatter description.
    const ship = collectRepoKind(repo, 'commands').find(c => c.name === 'ship')!;
    expect(ship.description).toBe('Ship the thing');
  });

  it('agrees with its own row about whether a repo hook is wired', () => {
    // The row read the repo's agents.yaml while the preview re-resolved the
    // CENTRAL one, so a hook the repo wires showed "PreToolUse(Bash)" in the
    // table and "not registered" in the pane directly below it.
    const root = makeProjectRepo();
    fs.mkdirSync(path.join(root, '.agents', 'hooks'), { recursive: true });
    // A name no central manifest would plausibly carry: with a plain `guard`,
    // a developer whose own ~/.agents/agents.yaml registered a guard.sh would
    // see the reverted code pass, and the test would prove nothing.
    fs.writeFileSync(path.join(root, '.agents', 'hooks', 'repo-only-guard.sh'), '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'),
      'hooks:\n  my-guard:\n    script: repo-only-guard.sh\n    events:\n      - PreToolUse\n    matcher: Bash\n');

    const repo = resolveRepoTarget(root)!;
    const guard = collectRepoKind(repo, 'hooks').find(h => h.name === 'repo-only-guard')!;
    const manifest = hookManifestByScript(hookManifestFromFile(path.join(repo.root, 'agents.yaml')));

    // What the row shows.
    const hook = manifest.get('repo-only-guard')!;
    expect(summarizeHook(hook)).toBe('PreToolUse(Bash)');
    // What the pane shows, given the same manifest.
    const pane = stripAnsi(previewFor('hooks', guard, manifest));
    expect(pane).toContain('PreToolUse(Bash)');
    expect(pane).not.toContain('not registered');

    // And the mirror: a hook absent from this repo's manifest must not be
    // credited a central registration.
    fs.writeFileSync(path.join(root, '.agents', 'hooks', 'orphan.sh'), '#!/usr/bin/env bash\nexit 0\n');
    const orphan = collectRepoKind(repo, 'hooks').find(h => h.name === 'orphan')!;
    expect(stripAnsi(previewFor('hooks', orphan, manifest))).toContain('not registered');
  });

  it('skips build/tooling caches (__pycache__, node_modules)', () => {
    const root = makeProjectRepo();
    fs.mkdirSync(path.join(root, '.agents', 'commands', '__pycache__'));
    fs.mkdirSync(path.join(root, '.agents', 'commands', 'node_modules'));
    const repo = resolveRepoTarget(root)!;
    expect(collectRepoKind(repo, 'commands').map(c => c.name)).toEqual(['plain', 'ship']);
  });

  it('skips directory-doc files (README/AGENTS/CLAUDE/GEMINI), including symlinks', () => {
    const root = makeProjectRepo();
    const commandsDir = path.join(root, '.agents', 'commands');
    // Every resource dir carries README.md + AGENTS.md by convention, with
    // CLAUDE.md/GEMINI.md symlinked to AGENTS.md. None is a command.
    fs.writeFileSync(path.join(commandsDir, 'README.md'), '# Commands\n');
    fs.writeFileSync(path.join(commandsDir, 'AGENTS.md'), '# Maintenance\n');
    fs.symlinkSync('AGENTS.md', path.join(commandsDir, 'CLAUDE.md'));
    fs.symlinkSync('AGENTS.md', path.join(commandsDir, 'GEMINI.md'));
    const repo = resolveRepoTarget(root)!;
    // Only the real commands remain — the four doc files are filtered out.
    expect(collectRepoKind(repo, 'commands').map(c => c.name)).toEqual(['plain', 'ship']);
  });

  it('lists rules from subrules/, not the composed AGENTS.md output', () => {
    const root = makeProjectRepo();
    const rulesDir = path.join(root, '.agents', 'rules');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    // The composed output + its symlinks + the maintenance doc + the preset file.
    // None of these is a rule you can drill into by name.
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), '# Composed ruleset\n');
    fs.symlinkSync('AGENTS.md', path.join(rulesDir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(rulesDir, 'README.md'), '# Rules\n');
    fs.writeFileSync(path.join(rulesDir, 'rules.yaml'), 'presets:\n  default:\n    subrules: []\n');
    // The addressable fragments.
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'foundations.md'), '# Foundations\n\nF1.\n');
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'code-quality.md'), '# Code Quality\n\nTactics.\n');
    const repo = resolveRepoTarget(root)!;
    // Before this fix `subrules` came back as a single opaque leaf alongside the
    // doc files, so `--rule foundations` could never resolve.
    expect(collectRepoKind(repo, 'rules').map(r => r.name)).toEqual(['code-quality', 'foundations']);
  });

  it('omits the author row when the manifest author has no name', () => {
    const root = makeProjectRepo();
    const dir = path.join(root, '.agents', 'plugins', 'noauthor', '.claude-plugin');
    fs.mkdirSync(dir, { recursive: true });
    // loadPluginManifest is a bare JSON cast, so `author.name` is typed required
    // but never validated. An author object without a name used to push
    // `undefined` into the row list and crash the renderer on stripAnsi.
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
      name: 'noauthor', version: '1.0.0', description: 'no author name', author: { email: 'x@y.z' },
    }));
    const repo = resolveRepoTarget(root)!;
    const [plugin] = collectRepoKind(repo, 'plugins');
    expect(plugin.name).toBe('noauthor');
    expect(plugin.extra?.map(([k]) => k)).not.toContain('author');
    // Every emitted value must be a string — the crash was an undefined here.
    for (const [, v] of plugin.extra ?? []) expect(typeof v).toBe('string');
  });

  it('survives manifest fields whose JSON type contradicts the declared type', () => {
    const root = makeProjectRepo();
    const dir = path.join(root, '.agents', 'plugins', 'wrongtypes', '.claude-plugin');
    fs.mkdirSync(dir, { recursive: true });
    // loadPluginManifest validates only name/version; a string `dependencies` has truthy `.length`
    // but no `.join`, which threw in pluginToItem while building the list, taking down `inspect
    // .`, `--plugins`, and queries for other valid plugins.
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
      name: 'wrongtypes', version: 2, description: 'd', dependencies: 'some-plugin',
    }));
    const repo = resolveRepoTarget(root)!;
    const items = collectRepoKind(repo, 'plugins');
    expect(items.map(i => i.name)).toContain('wrongtypes');
    const plugin = items.find(i => i.name === 'wrongtypes')!;
    // A non-array `dependencies` still renders, and a numeric version coerces.
    expect(plugin.extra).toEqual(
      expect.arrayContaining([['version', '2'], ['depends on', 'some-plugin']]),
    );
    for (const [, v] of plugin.extra ?? []) expect(typeof v).toBe('string');
  });

  it('reads a dir-form subrule description from rule.md', () => {
    const root = makeProjectRepo();
    const dir = path.join(root, '.agents', 'rules', 'subrules', 'gh-merge-guard');
    fs.mkdirSync(dir, { recursive: true });
    // The directory form documented in lib/rules/compose.ts (SUBRULE_RULE_FILE).
    fs.writeFileSync(path.join(dir, 'rule.md'), '# Merge & Admin-Bypass Guard\n\nNever bypass.\n');
    const repo = resolveRepoTarget(root)!;
    const [rule] = collectRepoKind(repo, 'rules');
    expect(rule.name).toBe('gh-merge-guard');
    expect(rule.description).toBe('Merge & Admin-Bypass Guard');
  });

  it('falls back to the flat rules dir when there is no subrules/', () => {
    const root = makeProjectRepo();
    const rulesDir = path.join(root, '.agents', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'house-style.md'), '# House style\n');
    const repo = resolveRepoTarget(root)!;
    expect(collectRepoKind(repo, 'rules').map(r => r.name)).toEqual(['house-style']);
  });

  it('reads hooks through the grouped reader, matching the summary view', () => {
    const root = makeProjectRepo();
    const hooksDir = path.join(root, '.agents', 'hooks');
    // Hooks nest under event directories, and a script pairs with its data
    // sidecar. A flat readdir returned the event dir itself ('pre-tool-use') and
    // counted the sidecar separately, so `--hooks` and the summary disagreed.
    fs.mkdirSync(path.join(hooksDir, 'pre-tool-use'), { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-tool-use', 'guard.sh'), '#!/usr/bin/env bash\necho ok\n');
    fs.writeFileSync(path.join(hooksDir, 'pre-tool-use', 'guard.yaml'), 'matches: {}\n');
    fs.writeFileSync(path.join(hooksDir, 'README.md'), '# Hooks\n');

    const repo = resolveRepoTarget(root)!;
    const names = collectRepoKind(repo, 'hooks').map(h => h.name);
    // The nested script is found, its sidecar collapses into it, and neither the
    // event directory nor the directory doc is reported as a hook.
    expect(names).toEqual(['guard']);
    // The drill and the summary must never report different counts again — both
    // now go through listHookEntriesFromDir.
    expect(names).toEqual(listHookEntriesFromDir(hooksDir).map(h => h.name));
  });
});

describe('repoManifestSummary', () => {
  it('extracts run strategies and version pins from agents.yaml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-manifest-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'agents.yaml'),
      'run:\n  claude:\n    strategy: balanced\n  codex:\n    strategy: pinned\nagents:\n  claude: 2.1.170\n');

    const summary = repoManifestSummary(dir)!;
    expect(summary.strategies).toEqual([
      { agent: 'claude', strategy: 'balanced' },
      { agent: 'codex', strategy: 'pinned' },
    ]);
    expect(summary.versions).toEqual([{ agent: 'claude', version: '2.1.170' }]);
  });

  it('returns null when agents.yaml is absent or has nothing to summarize', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-manifest-empty-'));
    tempDirs.push(dir);
    expect(repoManifestSummary(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'agents.yaml'), 'hooks:\n  some-hook:\n    script: x.sh\n');
    expect(repoManifestSummary(dir)).toBeNull();
  });
});

describe('pathSize', () => {
  it('sums file bytes and counts, recursing dirs and ignoring symlinks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-size-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');          // 5 bytes
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'world!!');  // 7 bytes
    // A symlink to a real file must not be followed/counted.
    fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'));

    const size = pathSize(dir);
    expect(size.bytes).toBe(12);
    expect(size.files).toBe(2);
  });

  it('returns zero for a missing path', () => {
    expect(pathSize(path.join(os.tmpdir(), 'definitely-missing-xyz'))).toEqual({ bytes: 0, files: 0 });
  });
});

describe('wrapJoined', () => {
  it('wraps separator-joined values with a hanging indent', () => {
    const lines = wrapJoined('  versions  ', ['claude 1.0.0', 'codex 2.0.0', 'kimi 3.0.0'], ' · ', 34);
    expect(lines).toEqual([
      '  versions  claude 1.0.0',
      '            codex 2.0.0',
      '            kimi 3.0.0',
    ]);
    expect(lines.every((line) => stringWidth(line) <= 34)).toBe(true);
  });

  it('keeps a wide row on one line', () => {
    expect(wrapJoined('  run       ', ['claude:balanced', 'codex:pinned'], ' · ', 80)).toEqual([
      '  run       claude:balanced · codex:pinned',
    ]);
  });
});

describe('summaryLine', () => {
  it('drops the trigger clause so the row says what the thing does', () => {
    // 15 of 20 skills in .system append "Triggers on: …" to their description.
    // In a one-line row that clause is what survived truncation, so the row
    // showed trigger keywords instead of the purpose.
    expect(summaryLine(
      "Manage AI coding agent CLIs with agents-cli. Triggers on: 'agents add', 'agents use', installing agent versions",
    )).toBe('Manage AI coding agent CLIs with agents-cli.');

    expect(summaryLine(
      'Drive a browser to automate websites — fill forms, click buttons. Use this skill when automating a site.',
    )).toBe('Drive a browser to automate websites — fill forms, click buttons.');
  });

  it('keeps the whole text when there is no trigger clause and no sentence break', () => {
    expect(summaryLine('Write documentation — user-facing, technical, runbooks'))
      .toBe('Write documentation — user-facing, technical, runbooks');
  });

  it('does not chop a description to a fragment on an early abbreviation', () => {
    // A naive first-sentence split would cut at "e.g." and leave three words.
    const d = 'Publish artifacts, e.g. Plans and reports, to a shareable link on your own storage.';
    expect(summaryLine(d)).toBe(d);
  });

  it('is empty for an empty description', () => {
    expect(summaryLine('')).toBe('');
  });

  it('never blanks a row when the description OPENS with the trigger clause', () => {
    // The split yields an empty head here. Returning it would render an empty
    // cell while --json still carried the full text — showing less than we have.
    const d = 'Triggers on: reflect, step back, reconsider, recall feedback.';
    expect(summaryLine(d)).toBe(d);
    expect(summaryLine('Use this skill when rewriting a draft.'))
      .toBe('Use this skill when rewriting a draft.');
  });
});

describe('summarizeHook', () => {
  it('shows events only when there is no matcher or predicate', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['SessionStart'] })).toBe('SessionStart');
  });

  it('joins multiple events with a slash', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['PreToolUse', 'PostToolUse'] }))
      .toBe('PreToolUse/PostToolUse');
  });

  it('survives agents.yaml values whose YAML type contradicts the declared type', () => {
    // A hook entry is an unvalidated yaml.parse cast: a scalar `events` is neither null nor an
    // array, so `.join()` threw, killing `agents inspect <repo>` and, via the central manifest,
    // every box's `inspect <agent>`. Render the scalar, don't drop it.
    expect(summarizeHook({ script: 'x.sh', events: 'PreToolUse' } as unknown as ManifestHook))
      .toBe('PreToolUse');
    // Predicates reach `truncate`, which calls `.slice`.
    expect(summarizeHook({
      script: 'x.sh',
      events: ['Stop'],
      matches: { prompt_contains: 12345, cwd_includes: 99 },
    } as unknown as ManifestHook)).toBe('Stop · prompt~"12345" · cwd~99');
    // An object carries no one-line form: dropped, never `[object Object]`.
    expect(summarizeHook({
      script: 'x.sh', events: [{ a: 1 }, 'Stop'],
    } as unknown as ManifestHook)).toBe('Stop');
    expect(summarizeHook({ script: 'x.sh', events: {} } as unknown as ManifestHook))
      .toBe('(no event)');
    // `cache: 5` has no `.ttl` and `{ttl: {…}}` has a non-scalar one; both used
    // to render a tail reading `(undefined cache)` / `([object Object] cache)`.
    for (const cache of [5, [1, 2], { ttl: { a: 1 } }, {}]) {
      expect(summarizeHook({ script: 'x.sh', events: ['Stop'], cache } as unknown as ManifestHook))
        .toBe('Stop');
    }
    // A well-formed ttl still renders.
    expect(summarizeHook({ script: 'x.sh', events: ['Stop'], cache: { ttl: '5m' } } as unknown as ManifestHook))
      .toBe('Stop (5m cache)');
  });

  it('puts the matcher in parens after the events', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['PreToolUse'], matcher: 'Bash' }))
      .toBe('PreToolUse(Bash)');
  });

  it('uses matches.tool_name as the matcher when no explicit matcher is set', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['PreToolUse'], matches: { tool_name: ['Bash', 'Edit'] } }))
      .toBe('PreToolUse(Bash|Edit)');
  });

  it('appends a `·`-separated predicate summary from matches', () => {
    const hook: ManifestHook = {
      script: 'x.sh',
      events: ['PreToolUse'],
      matcher: 'Bash',
      matches: { git_dirty: true, prompt_contains: 'deploy' },
    };
    expect(summarizeHook(hook)).toBe('PreToolUse(Bash) · git_dirty · prompt~"deploy"');
  });

  it('adds a cache tail, stripping the -bg background suffix', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['SessionStart'], cache: '5m-bg' }))
      .toBe('SessionStart (5m cache)');
    expect(summarizeHook({ script: 'x.sh', events: ['SessionStart'], cache: { ttl: '1h', key: 'per-cwd' } }))
      .toBe('SessionStart (1h cache)');
  });
});

describe('summarizeMcp', () => {
  it('renders an http server as transport + url', () => {
    expect(summarizeMcp({ name: 'posthog', transport: 'http', url: 'https://mcp.posthog.com' }))
      .toBe('http   https://mcp.posthog.com');
  });

  it('renders a stdio server as transport + command line', () => {
    expect(summarizeMcp({ name: 'linear', transport: 'stdio', command: 'npx', args: ['linear-mcp-server'] }))
      .toBe('stdio  npx linear-mcp-server');
  });
});

describe('hookManifestByScript', () => {
  it('keys hooks by their script basename without extension, not the manifest key', () => {
    const manifest: Record<string, ManifestHook> = {
      'capture-session-start-metadata': { script: '04-capture-session-start-metadata.sh', events: ['SessionStart'] },
      'git-guard': { script: 'git-guard.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const byScript = hookManifestByScript(manifest);
    // Installed hook names equal the script basename, so that is the join key.
    expect(byScript.get('04-capture-session-start-metadata')?.events).toEqual(['SessionStart']);
    expect(byScript.get('git-guard')?.matcher).toBe('Bash');
    // The manifest key itself is NOT a lookup key.
    expect(byScript.get('capture-session-start-metadata')).toBeUndefined();
  });
});

describe('repoGitInfo', () => {
  it('reports branch, last commit, and dirty files on a real repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-git-'));
    tempDirs.push(dir);
    const g = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t.t']);
    g(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    g(['add', 'a.txt']);
    g(['commit', '-q', '-m', 'first commit']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');   // make the tree dirty

    const info = repoGitInfo(dir)!;
    expect(info.branch).toBe('main');
    expect(info.lastCommit?.subject).toBe('first commit');
    expect(info.lastCommit?.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(info.dirtyFiles).toContain('a.txt');
    expect(info.dirty).toBe(1);
  });

  // The `$(touch ...)` payload is POSIX syntax with an absolute sentinel path (illegal on
  // Windows), so this runs on POSIX only. The fix (argv-form execFileSync) removes the shell
  // everywhere, so Windows is covered by construction.
  it.skipIf(process.platform === 'win32')('treats a repo path with shell metacharacters as a literal argument', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inject-'));
    tempDirs.push(base);
    const sentinel = path.join(base, 'pwned');
    const maliciousDir = path.join(base, `$(touch ${sentinel})`);
    fs.mkdirSync(maliciousDir, { recursive: true });
    expect(fs.existsSync(sentinel)).toBe(false);

    const info = repoGitInfo(maliciousDir);

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(info).toBeNull();
  });

  it('returns null for a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-nogit-'));
    tempDirs.push(dir);
    expect(repoGitInfo(dir)).toBeNull();
  });
});

// ─── Routines ────────────────────────────────────────────────────────────────

/** A DotAgents repo whose routines/ dir also holds sandbox overlay HOMEs. */
function makeRoutinesRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-routines-'));
  tempDirs.push(root);
  const routinesDir = path.join(root, 'routines');
  fs.mkdirSync(routinesDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'agents.yaml'), 'agents: {}\n');
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(routinesDir, name), body);
  }
  return root;
}

function repoAt(root: string) {
  return { label: 'fixture', root };
}

/** Live state a test controls, so nothing reads the developer's real fleet. */
function fakeLive(overrides: Partial<RoutineLiveState> = {}): (name: string) => RoutineLiveState {
  return () => ({
    devices: [], materialized: false, thisDevice: 'testbox', enabledHere: null,
    lastStatus: null, lastAt: null, ...overrides,
  });
}

/** One `extra` row's value, or '' — mirrors the renderers' accessor. */
function extraValue(item: { extra?: Array<[string, string]> }, key: string): string {
  return item.extra?.find(([k]) => k === key)?.[1] ?? '';
}

const AGENT_ROUTINE = 'name: daily\nschedule: "0 9 * * *"\nagent: claude\nprompt: Review the queue and file what is stale.\n';

describe('collectRepoRoutines', () => {
  it('reads *.yml only, ignoring the <name>/home/ sandbox overlays', () => {
    const root = makeRoutinesRepo({ 'daily.yml': AGENT_ROUTINE });
    // Both a matching overlay and an orphan left behind by a removed routine.
    fs.mkdirSync(path.join(root, 'routines', 'daily', 'home'), { recursive: true });
    fs.mkdirSync(path.join(root, 'routines', 'gone', 'home'), { recursive: true });

    const items = collectRepoRoutines(repoAt(root), fakeLive());
    expect(items.map(i => i.name)).toEqual(['daily']);
  });

  it('returns an empty list when the repo declares no routines', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-noroutines-'));
    tempDirs.push(root);
    expect(collectRepoRoutines(repoAt(root), fakeLive())).toEqual([]);
  });

  it('takes the name from the YAML, not the filename', () => {
    const root = makeRoutinesRepo({ 'renamed-file.yml': AGENT_ROUTINE });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive());
    // Everything downstream (device allowlist, run history, sandbox home) keys
    // on the declared name, so a disagreeing basename is worth surfacing.
    expect(item.name).toBe('daily');
    expect(item.extra).toContainEqual(['file', 'renamed-file.yml']);
  });

  it('surfaces a fail-closed config instead of hiding it', () => {
    const root = makeRoutinesRepo({
      'inert.yml': 'name: inert\nschedule: "0 9 * * *"\ndevices: yosemite-s0\nagent: claude\n',
    });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive());
    expect(item.name).toBe('inert');
    expect(item.extra?.find(([k]) => k === 'problem')?.[1]).toMatch(/must be a list/);
  });

  it('surfaces the legacy `device:` key rather than dropping the file', () => {
    const root = makeRoutinesRepo({
      'old.yml': 'name: old\ndevice: zion\nschedule: "0 9 * * *"\nagent: claude\n',
    });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive());
    expect(item.extra?.find(([k]) => k === 'problem')?.[1]).toMatch(/legacy `device:` key/);
  });

  it('surfaces unparseable YAML rather than dropping the file', () => {
    const root = makeRoutinesRepo({ 'bad.yml': 'name: bad\nschedule: "0 9 * * *\n  unclosed: [\n' });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive());
    expect(item.name).toBe('bad');
    expect(item.extra?.find(([k]) => k === 'problem')?.[1]).toMatch(/invalid YAML/);
  });

  it('flags a .yml/.yaml collision and describes the file the loader actually loads', () => {
    // readJobFromDir tries `.yml` before `.yaml`, so `.yml` is what fires. A plain
    // alphabetical sort described `.yaml` — the wrong schedule and command.
    const root = makeRoutinesRepo({
      'dup.yaml': 'name: dup\nschedule: "0 9 * * *"\ncommand: echo FROM_YAML\n',
      'dup.yml': 'name: dup\nschedule: "0 3 * * *"\ncommand: echo FROM_YML\n',
    });
    const items = collectRepoRoutines(repoAt(root), fakeLive());
    expect(items).toHaveLength(1);
    expect(items[0].path).toMatch(/dup\.yml$/);
    expect(items[0].json?.command).toBe('echo FROM_YML');
    expect(items[0].json?.scheduleHuman).toBe('daily at 3:00 AM');
    // The problem reaches BOTH renderers: extra for the panes, json for --json.
    expect(items[0].extra?.find(([k]) => k === 'problem')?.[1]).toMatch(/both \.yml and \.yaml/);
    expect(String(items[0].json?.problem)).toMatch(/both \.yml and \.yaml/);
  });

  it('keeps a collided routine\'s schedule and status in the overview row', () => {
    // A duplicate sibling must not blank an otherwise-healthy routine's row.
    const root = makeRoutinesRepo({
      'dup.yml': 'name: dup\nschedule: "0 3 * * *"\ncommand: echo hi\n',
      'dup.yaml': 'name: dup\ncommand: echo bye\n',
    });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive({ devices: ['testbox'], materialized: true }));
    expect(extraValue(item, 'fires')).toBe('daily at 3:00 AM');
    expect(extraValue(item, 'devices')).toBe('testbox');
  });

  it('folds the enabled devices and the last run into extra', () => {
    const root = makeRoutinesRepo({ 'daily.yml': AGENT_ROUTINE });
    const [item] = collectRepoRoutines(
      repoAt(root),
      fakeLive({ devices: ['zion'], materialized: true, lastStatus: 'failed', lastAt: '2026-08-07T16:00:00.000Z' }),
      new Date('2026-08-09T16:00:00.000Z'),
    );
    expect(item.extra).toContainEqual(['devices', 'zion']);
    expect(item.extra).toContainEqual(['last', 'failed · 2d ago']);
    expect(item.json?.enabledDevices).toEqual(['zion']);
    expect(item.json?.lastStatus).toBe('failed');
  });

  it('says a routine will not fire only once some device has an allowlist', () => {
    const root = makeRoutinesRepo({ 'daily.yml': AGENT_ROUTINE });

    const [unmaterialized] = collectRepoRoutines(repoAt(root), fakeLive({ materialized: false }));
    expect(unmaterialized.extra).toContainEqual(['devices', 'no device allowlist yet']);

    const [dark] = collectRepoRoutines(repoAt(root), fakeLive({ materialized: true }));
    expect(dark.extra).toContainEqual(['devices', 'no device — will not fire']);
  });

  it('reports enablement for THIS device, matching `agents routines list`', () => {
    const root = makeRoutinesRepo({ 'daily.yml': AGENT_ROUTINE });
    // enabledHere is this device's own answer — the same one applyDeviceActivation asks.
    const [off] = collectRepoRoutines(repoAt(root), fakeLive({ devices: ['other'], materialized: true, enabledHere: false }));
    expect(off.json?.enabled).toBe(false);

    const [on] = collectRepoRoutines(repoAt(root), fakeLive({ devices: ['testbox'], materialized: true, enabledHere: true }));
    expect(on.json?.enabled).toBe(true);
  });

  it('keeps the file value when THIS device has no allowlist, even if a peer does', () => {
    // The freshly-synced-member case. `materialized` is fleet-wide, so keying
    // `enabled` on it reported `no` for routines the daemon was actively firing.
    // applyDeviceActivation only overrides when THIS device answers non-null.
    const root = makeRoutinesRepo({
      'on.yml': 'name: on\nschedule: "0 9 * * *"\nagent: claude\nenabled: true\n',
      'off.yml': 'name: off\nschedule: "0 9 * * *"\nagent: claude\nenabled: false\n',
    });
    const peerOnly = fakeLive({ devices: ['mac-mini'], materialized: true, enabledHere: null });
    const items = collectRepoRoutines(repoAt(root), peerOnly);
    expect(items.find(i => i.name === 'on')?.json?.enabled).toBe(true);
    expect(items.find(i => i.name === 'off')?.json?.enabled).toBe(false);
  });

  it('keeps every extra value free of ANSI — they become JSON keys', () => {
    const root = makeRoutinesRepo({ 'daily.yml': AGENT_ROUTINE, 'bad.yml': 'name: bad\n[' });
    for (const item of collectRepoRoutines(repoAt(root), fakeLive({ materialized: true }))) {
      for (const [key, value] of item.extra ?? []) {
        expect(stripAnsi(value), `extra.${key}`).toBe(value);
      }
    }
  });

  it('separates the YAML devices pin from the devices that actually enable it', () => {
    const root = makeRoutinesRepo({
      'pinned.yml': 'name: pinned\nschedule: "0 9 * * *"\nagent: claude\ndevices:\n  - zion\n',
    });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive({ materialized: true }));
    // The exact inversion that let 22 routines go dark unnoticed.
    expect(item.json?.devices).toEqual(['zion']);
    expect(item.json?.enabledDevices).toEqual([]);
  });
});

describe('routineDescription', () => {
  it('uses the first sentence of an agent routine prompt', () => {
    const root = makeRoutinesRepo({ 'daily.yml': AGENT_ROUTINE });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive());
    expect(item.description).toBe('Review the queue and file what is stale.');
  });

  it('falls back to the leading comment block for a command routine', () => {
    const root = makeRoutinesRepo({
      'sync.yml': '# Routine: auto-close Linear issues when their PRs merge.\nname: sync\ncommand: linear sync\n',
    });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive());
    expect(item.description).toBe('auto-close Linear issues when their PRs merge.');
  });

  it('falls back to the first real line of a shell command', () => {
    const root = makeRoutinesRepo({
      'shell.yml': 'name: shell\ncommand: |\n  set -euo pipefail\n  linear sync --auto-close\n',
    });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive());
    expect(item.description).toBe('linear sync --auto-close');
  });

  it('returns empty rather than echoing YAML when there is nothing to say', () => {
    expect(routineDescription(null, 'name: x\nschedule: "0 9 * * *"\n')).toBe('');
  });
});

describe('routineFireLabel', () => {
  const job = (extra: Record<string, unknown>) => ({ name: 'r', ...extra }) as never;

  it('humanizes a cron schedule', () => {
    expect(routineFireLabel(job({ schedule: '0 9 * * *' }))).toBe('daily at 9:00 AM');
    expect(routineFireLabel(job({ schedule: '0 9 * * 1-5' }))).toBe('weekdays at 9:00 AM');
  });

  it('describes an event-triggered routine that has no schedule', () => {
    expect(routineFireLabel(job({ trigger: { type: 'github_event', event: 'pull_request', action: 'opened' } })))
      .toBe('on pull_request (opened)');
  });

  it('says so when nothing fires the routine at all', () => {
    expect(routineFireLabel(job({}))).toBe('no schedule or trigger');
  });

  it('marks a one-shot, and an expired one', () => {
    const now = new Date('2026-08-09T12:00:00Z');
    const future = routineFireLabel(job({ schedule: '0 9 3 9 *', runOnce: true }), now);
    expect(future).toContain('(one-shot)');
    const past = routineFireLabel(job({ schedule: '0 9 1 1 *', runOnce: true }), now);
    expect(past).toContain('expired');
  });
});

describe('routineTargetLabel', () => {
  const job = (extra: Record<string, unknown>) => ({ name: 'r', ...extra }) as never;

  it('names the agent, workflow, or shell command', () => {
    expect(routineTargetLabel(job({ agent: 'codex' }))).toBe('agent codex');
    expect(routineTargetLabel(job({ workflow: 'ship' }))).toBe('workflow ship');
    expect(routineTargetLabel(job({ command: 'echo hi' }))).toBe('command (shell)');
    expect(routineTargetLabel(job({}))).toBe('nothing configured');
  });
});

describe('routineHealthTier', () => {
  const item = (extra: Array<[string, string]>) =>
    ({ name: 'r', source: 'fixture', path: '', linkTarget: '', description: '', extra });

  it('ranks inert, then dark, then disabled, then failing, ahead of healthy', () => {
    const inert = item([['problem', 'invalid YAML']]);
    const dark = item([['devices', 'no device — will not fire'], ['enabled', 'no'], ['last', 'completed']]);
    const disabled = item([['devices', 'zion'], ['enabled', 'no'], ['last', 'completed']]);
    const failing = item([['devices', 'zion'], ['enabled', 'yes'], ['last', 'failed · 2d ago']]);
    const healthy = item([['devices', 'zion'], ['enabled', 'yes'], ['last', 'completed · 2h ago']]);

    const tiers = [inert, dark, disabled, failing, healthy].map(routineHealthTier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers).size).toBe(5);
  });

  it('sorts an expired one-shot last', () => {
    const expired = item([['fires', 'daily at 9:00 AM (one-shot, expired)'], ['devices', 'zion'], ['enabled', 'yes'], ['last', 'completed']]);
    const healthy = item([['fires', 'daily at 9:00 AM'], ['devices', 'zion'], ['enabled', 'yes'], ['last', 'completed']]);
    expect(routineHealthTier(expired)).toBeGreaterThan(routineHealthTier(healthy));
  });

  it('cannot leave a dark routine behind the …(+N) tail', () => {
    // printExpandedSection shows only the first 6, so the sort IS the section.
    const healthy = Array.from({ length: 20 }, (_, i) => ({
      name: `aaa-healthy-${i}`, source: 'fixture', path: '', linkTarget: '', description: '',
      extra: [['devices', 'zion'], ['enabled', 'yes'], ['last', 'completed · 1h ago']] as Array<[string, string]>,
    }));
    const dark = { name: 'zzz-dark', source: 'fixture', path: '', linkTarget: '', description: '',
      extra: [['devices', 'no device — will not fire'], ['enabled', 'no'], ['last', 'never run']] as Array<[string, string]> };

    const ordered = [...healthy, dark].sort((a, b) => {
      const t = routineHealthTier(a) - routineHealthTier(b);
      return t !== 0 ? t : a.name.localeCompare(b.name);
    });
    expect(ordered.slice(0, 6).map(r => r.name)).toContain('zzz-dark');
  });
});

describe('routineDarkWarning', () => {
  const item = (devices: string) =>
    ({ name: 'r', source: 'fixture', path: '', linkTarget: '', description: '', extra: [['devices', devices]] as Array<[string, string]> });

  it('stays silent before any device has materialized an allowlist', () => {
    expect(routineDarkWarning([item('no device allowlist yet'), item('no device allowlist yet')])).toBeNull();
  });

  it('stays silent when every routine fires somewhere', () => {
    expect(routineDarkWarning([item('zion'), item('mac-mini')])).toBeNull();
  });

  it('counts only the routines that fire nowhere', () => {
    const warning = routineDarkWarning([item('zion'), item('no device — will not fire'), item('no device — will not fire')]);
    expect(warning).toMatch(/^2 of 3 routines are on no device's allowlist/);
  });

  it('reads correctly for a single dark routine', () => {
    expect(routineDarkWarning([item('zion'), item('no device — will not fire')]))
      .toMatch(/^1 of 2 routines is on no device's allowlist — it will not fire\./);
  });
});

describe('compactAge', () => {
  const now = new Date('2026-08-09T12:00:00Z');

  it('renders a compact relative age', () => {
    expect(compactAge('2026-08-09T11:59:30Z', now)).toBe('now');
    expect(compactAge('2026-08-09T11:30:00Z', now)).toBe('30m');
    expect(compactAge('2026-08-09T09:00:00Z', now)).toBe('3h');
    expect(compactAge('2026-08-06T12:00:00Z', now)).toBe('3d');
  });

  it('returns empty for a missing or unparseable timestamp', () => {
    expect(compactAge(null, now)).toBe('');
    expect(compactAge('not-a-date', now)).toBe('');
  });
});

describe('previewFor — routines', () => {
  it('renders the routine rows in the preview pane', () => {
    const root = makeRoutinesRepo({ 'daily.yml': AGENT_ROUTINE });
    const [item] = collectRepoRoutines(repoAt(root), fakeLive({ devices: ['zion'], materialized: true }));
    const pane = stripAnsi(previewFor('routines', item, new Map()));
    expect(pane).toContain('daily at 9:00 AM');
    expect(pane).toContain('agent claude');
    expect(pane).toContain('zion');
  });
});
