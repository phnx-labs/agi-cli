import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, MarketplaceSpec } from './types.js';
import { supports } from './capabilities.js';
import { getEnabledExtraRepos, getProjectAgentsDir, getSystemAgentsDir, getSystemPluginsDir, getUserAgentsDir } from './state.js';
import { getVersionHomePath } from './installations/versions.js';
import { listResources } from './resources.js';
import { removeCommandFromVersion } from './commands.js';
import { removeSkillFromVersion } from './plugins/skills.js';
import { cleanOrphanedPluginSkills, discoverPlugins, listVersionMarketplaceNames } from './plugins/plugins.js';
import { marketplaceNameFor, marketplaceRoot } from './plugins/plugin-marketplace.js';
import { loadManifest, saveManifest } from './staleness/index.js';
import { getDetector } from './staleness/registry.js';

export interface RepoRemovalReport {
  agent: AgentId;
  version: string;
  removed: { plugins: string[]; commands: string[]; skills: string[] };
  kept: { notFromRepo: string[]; stillProvided: string[] };
}

function repoSource(repo: string, cwd: string): { root: string; marketplace: string } {
  let root: string | null;
  let spec: MarketplaceSpec;
  if (repo === 'project') {
    root = getProjectAgentsDir(cwd);
    spec = { kind: 'project', root: root ? path.join(root, 'plugins') : '' };
  } else if (repo === 'user') {
    root = getUserAgentsDir();
    spec = { kind: 'user' };
  } else if (repo === 'system') {
    root = getSystemAgentsDir();
    spec = { kind: 'system', root: getSystemPluginsDir() };
  } else {
    const extra = getEnabledExtraRepos().find((e) => e.alias === repo);
    root = extra?.dir ?? null;
    spec = { kind: 'extra', alias: repo, root: extra ? path.join(extra.dir, 'plugins') : '' };
  }
  if (!root || !fs.existsSync(root)) {
    throw new Error(`The '${repo}' repo has no checkout on this machine, so nothing can be proven to have come from it.`);
  }
  return { root, marketplace: marketplaceNameFor(spec) };
}

function within(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function pruneRepoRemovals(args: {
  agent: AgentId;
  version: string;
  repo: string;
  cwd: string;
  dryRun: boolean;
}): RepoRemovalReport {
  const { agent, version, repo, cwd, dryRun } = args;
  const versionHome = getVersionHomePath(agent, version);
  const { root, marketplace } = repoSource(repo, cwd);
  const report: RepoRemovalReport = {
    agent,
    version,
    removed: { plugins: [], commands: [], skills: [] },
    kept: { notFromRepo: [], stillProvided: [] },
  };

  if (supports(agent, 'plugins', version).ok) {
    report.removed.plugins = cleanOrphanedPluginSkills(agent, versionHome, discoverPlugins({ cwd }), version, { marketplace, cwd, dryRun });
    for (const name of listVersionMarketplaceNames(agent, versionHome)) {
      if (name === marketplace) continue;
      const dir = path.join(marketplaceRoot(name, agent, versionHome), 'plugins');
      if (!fs.existsSync(dir)) continue;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) report.kept.notFromRepo.push(`plugin ${e.name}`);
      }
    }
  }

  const manifest = loadManifest(agent, version);
  const provenance = {
    commands: Object.fromEntries(
      Object.entries({ ...manifest?.retired?.commands, ...manifest?.commands }).map(([n, e]) => [n, e.source.path]),
    ),
    skills: Object.fromEntries(
      Object.entries({ ...manifest?.retired?.skills, ...manifest?.skills }).map(([n, e]) => [n, e.dirPath]),
    ),
  };
  const kinds = [
    { kind: 'commands' as const, label: 'command', remove: removeCommandFromVersion },
    { kind: 'skills' as const, label: 'skill', remove: removeSkillFromVersion },
  ];
  for (const { kind, label, remove } of kinds) {
    const detector = getDetector(kind, agent);
    if (!detector || !supports(agent, kind, version).ok) continue;
    const provided = new Set(listResources(kind, cwd).map((r) => r.name));
    const kindDir = path.join(root, kind);
    for (const name of detector.list({ version, versionHome, cwd })) {
      const source = provenance[kind][name];
      if (!source || !within(kindDir, source)) {
        report.kept.notFromRepo.push(`${label} ${name}`);
        continue;
      }
      if (fs.existsSync(source)) continue;
      if (provided.has(name)) {
        report.kept.stillProvided.push(`${label} ${name}`);
        continue;
      }
      if (!dryRun) {
        const result = remove(agent, version, name);
        if (!result.success) throw new Error(`could not trash ${label} '${name}' from ${agent}@${version}: ${result.error}`);
        if (manifest) {
          delete manifest[kind][name];
          if (manifest.retired) delete manifest.retired[kind][name];
          if (kind === 'commands' && manifest.writtenCommands) {
            manifest.writtenCommands = manifest.writtenCommands.filter((c) => c !== name);
          }
        }
      }
      report.removed[kind].push(name);
    }
  }
  if (manifest && !dryRun && (report.removed.commands.length > 0 || report.removed.skills.length > 0)) {
    saveManifest(agent, version, manifest);
  }
  return report;
}
