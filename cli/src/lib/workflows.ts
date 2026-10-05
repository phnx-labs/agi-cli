
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import { capableAgents, supports } from './capabilities.js';
import {
  getProjectAgentsDir,
  getSystemWorkflowsDir,
  getUserWorkflowsDir,
  getTrashWorkflowsDir,
  getEnabledExtraRepos,
  getPluginsDir,
  getSystemPluginsDir,
  getProjectPluginsDir,
} from './state.js';
import { listInstalledVersions } from './installations/versions.js';


export interface LoopConfigRaw {
  until?: 'signal';
  max_iterations?: number;
  budget?: number;
  interval?: string;
}

export interface ForEachVerifySpec {
  agent: string;
  prompt?: string;
  votes: number;
  keep_if: 'majority' | 'all' | 'any';
}

export interface ForEachSpec {
  produce?: string;
  itemsRef?: string;
  agent: string;
  name?: string;
  prompt: string;
  concurrency?: number;
  max_items?: number;
  verify?: ForEachVerifySpec;
}

export const DEFAULT_FOR_EACH_CAP = 256;

export interface WorkflowFrontmatter {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  allowedAgents?: string[];
  secrets?: string[];
  loop?: LoopConfigRaw;
  forEach?: ForEachSpec;
}

interface DiscoveredWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

export interface InstalledWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

export function parseWorkflowFrontmatter(workflowDir: string): WorkflowFrontmatter | null {
  const workflowMdPath = path.join(workflowDir, 'WORKFLOW.md');
  if (!fs.existsSync(workflowMdPath)) return null;

  try {
    const content = fs.readFileSync(workflowMdPath, 'utf-8');
    const lines = content.split('\n');
    if (lines[0] !== '---') return null;
    const endIndex = lines.slice(1).findIndex(l => l === '---');
    if (endIndex < 0) return null;

    const frontmatter = lines.slice(1, endIndex + 1).join('\n');
    const parsed = yaml.parse(frontmatter);
    if (!parsed || typeof parsed !== 'object') return null;

    const asStringArray = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;

    return {
      name: parsed.name || '',
      description: parsed.description || '',
      model: parsed.model,
      tools: asStringArray(parsed.tools),
      skills: asStringArray(parsed.skills),
      mcpServers: asStringArray(parsed.mcpServers),
      allowedAgents: asStringArray(parsed.allowedAgents),
      secrets: asStringArray(parsed.secrets),
      loop: parseLoopBlock(parsed.loop),
      forEach: parseForEachBlock(parsed.for_each),
    };
  } catch {
    return null;
  }
}

function readWorkflowBody(workflowDir: string): string {
  const workflowMdPath = path.join(workflowDir, 'WORKFLOW.md');
  if (!fs.existsSync(workflowMdPath)) return '';
  const content = fs.readFileSync(workflowMdPath, 'utf-8');
  const lines = content.split('\n');
  if (lines[0] !== '---') return content.trim();
  const endIndex = lines.slice(1).findIndex(l => l === '---');
  if (endIndex < 0) return content.trim();
  return lines.slice(endIndex + 2).join('\n').trim();
}

export function parseLoopBlock(v: unknown): LoopConfigRaw | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out: LoopConfigRaw = {};

  if (raw.until === 'signal') out.until = 'signal';

  if (typeof raw.max_iterations === 'number'
    && Number.isFinite(raw.max_iterations)
    && Number.isInteger(raw.max_iterations)
    && raw.max_iterations > 0) {
    out.max_iterations = raw.max_iterations;
  }

  if (typeof raw.budget === 'number' && Number.isFinite(raw.budget) && raw.budget > 0) {
    out.budget = raw.budget;
  }

  if (typeof raw.interval === 'string') out.interval = raw.interval;

  return Object.keys(out).length > 0 ? out : undefined;
}

function asPosInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0
    ? v
    : undefined;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

export function parseVerifyBlock(v: unknown): ForEachVerifySpec | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;

  const agent = asNonEmptyString(raw.agent);
  if (!agent) return undefined;

  const keepIf = raw.keep_if;
  const out: ForEachVerifySpec = {
    agent,
    votes: asPosInt(raw.votes) ?? 1,
    keep_if:
      keepIf === 'all' || keepIf === 'any' || keepIf === 'majority'
        ? keepIf
        : 'majority',
  };
  const prompt = asNonEmptyString(raw.prompt);
  if (prompt) out.prompt = prompt;
  return out;
}

export function parseForEachBlock(v: unknown): ForEachSpec | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;

  const agent = asNonEmptyString(raw.agent);
  const prompt = asNonEmptyString(raw.prompt);
  if (!agent || !prompt) return undefined;

  const out: ForEachSpec = { agent, prompt };

  const produce = asNonEmptyString(raw.produce);
  if (produce) out.produce = produce;
  const itemsRef = asNonEmptyString(raw.for_each) ?? asNonEmptyString(raw.items_ref);
  if (itemsRef) out.itemsRef = itemsRef;

  const name = asNonEmptyString(raw.name);
  if (name) out.name = name;

  const concurrency = asPosInt(raw.concurrency);
  if (concurrency) out.concurrency = concurrency;

  const maxItems = asPosInt(raw.max_items);
  if (maxItems) out.max_items = maxItems;

  const verify = parseVerifyBlock(raw.verify);
  if (verify) out.verify = verify;

  return out;
}

export interface ForEachTeammate {
  role: 'stage' | 'verify';
  name: string;
  agentType: string;
  prompt: string;
  after: string[];
  item: string;
  itemIndex: number;
  vote?: number;
  votes?: number;
  keep_if?: 'majority' | 'all' | 'any';
}

interface ForEachExpansion {
  teammates: ForEachTeammate[];
  producedCount: number;
  usedCount: number;
  truncated: number;
  cap: number;
}

export function renderForEachTemplate(template: string, item: string, index: number): string {
  return template
    .replace(/\{\{\s*item\s*\}\}/g, item)
    .replace(/\{\{\s*index\s*\}\}/g, String(index))
    .replace(/\{\{\s*n\s*\}\}/g, String(index + 1));
}

export function expandForEach(
  spec: ForEachSpec,
  items: string[],
  opts: { producerName?: string } = {},
): ForEachExpansion {
  const cap = spec.max_items ?? DEFAULT_FOR_EACH_CAP;
  const producedCount = items.length;
  const used = items.slice(0, cap);
  const base = spec.name ?? 'item';
  const teammates: ForEachTeammate[] = [];

  used.forEach((item, itemIndex) => {
    const stageName = `${base}-${itemIndex + 1}`;
    teammates.push({
      role: 'stage',
      name: stageName,
      agentType: spec.agent,
      prompt: renderForEachTemplate(spec.prompt, item, itemIndex),
      after: opts.producerName ? [opts.producerName] : [],
      item,
      itemIndex,
    });

    if (spec.verify) {
      const verifyPrompt = spec.verify.prompt ?? spec.prompt;
      for (let vote = 1; vote <= spec.verify.votes; vote++) {
        teammates.push({
          role: 'verify',
          name: `${stageName}-verify-${vote}`,
          agentType: spec.verify.agent,
          prompt: renderForEachTemplate(verifyPrompt, item, itemIndex),
          after: [stageName],
          item,
          itemIndex,
          vote,
          votes: spec.verify.votes,
          keep_if: spec.verify.keep_if,
        });
      }
    }
  });

  return {
    teammates,
    producedCount,
    usedCount: used.length,
    truncated: producedCount - used.length,
    cap,
  };
}

export function resolveAllowedSubagents(
  available: string[],
  allowedAgents: string[] | undefined,
): { allowedStems: string[]; missing: string[] } {
  const stems = available.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  if (allowedAgents === undefined) {
    return { allowedStems: stems, missing: [] };
  }
  const allow = new Set(allowedAgents);
  const present = new Set(stems);
  return {
    allowedStems: stems.filter(s => allow.has(s)),
    missing: allowedAgents.filter(a => !present.has(a)),
  };
}

const SUBAGENT_DISPATCH_TOOL = 'Task';

export function ensureSubagentDispatchTool(tools: string[], hasSubagents: boolean): string[] {
  if (!hasSubagents || tools.includes(SUBAGENT_DISPATCH_TOOL)) return tools;
  return [...tools, SUBAGENT_DISPATCH_TOOL];
}

export function pruneStaleWorkflowSubagents(
  sharedAgentsDir: string,
  workflowSubagentFiles: string[],
  allowedStems: string[],
): string[] {
  if (!fs.existsSync(sharedAgentsDir)) return [];
  const allow = new Set(allowedStems);
  const pruned: string[] = [];
  for (const file of workflowSubagentFiles) {
    if (!file.endsWith('.md')) continue;
    const stem = file.replace(/\.md$/, '');
    if (allow.has(stem)) continue;
    const target = path.join(sharedAgentsDir, file);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      pruned.push(file);
    }
  }
  return pruned;
}

export function countWorkflowSubagents(workflowDir: string): number {
  const subagentsDir = path.join(workflowDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return 0;
  try {
    return fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function getWorkflowBody(workflowDir: string): string {
  const workflowMdPath = path.join(workflowDir, 'WORKFLOW.md');
  if (!fs.existsSync(workflowMdPath)) return '';
  const content = fs.readFileSync(workflowMdPath, 'utf-8');
  const lines = content.split('\n');
  if (lines[0] === '---') {
    const endIndex = lines.slice(1).findIndex(l => l === '---');
    if (endIndex >= 0) return lines.slice(endIndex + 2).join('\n').trim();
  }
  return content.trim();
}

function indentD2BlockString(content: string): string {
  return content
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function containsFlowDiagram(content: string): boolean {
  return /```(?:mermaid|d2)\b/i.test(content);
}

const KIMI_WORKFLOW_MARKER = 'agents_workflow';
const OPENCLAW_WORKFLOW_MARKER_ENV = 'AGENTS_CLI_WORKFLOW';

export function transformWorkflowForKimi(workflowPath: string, name: string): string {
  const fm = parseWorkflowFrontmatter(workflowPath);
  if (!fm) throw new Error(`Invalid WORKFLOW.md in ${workflowPath}`);
  const body = getWorkflowBody(workflowPath);
  const frontmatter = yaml.stringify({
    name,
    description: fm.description,
    type: 'flow',
    [KIMI_WORKFLOW_MARKER]: name,
  }).trim();

  if (containsFlowDiagram(body)) {
    return `---\n${frontmatter}\n---\n\n${body.trim()}\n`;
  }

  const instructions = (body || fm.description).trim();
  return `---\n${frontmatter}\n---\n\n\`\`\`d2\nBEGIN -> step -> END\nstep: |md\n${indentD2BlockString(instructions)}\n|\n\`\`\`\n`;
}

export function transformWorkflowForAntigravity(workflowPath: string, name: string): string {
  const fm = parseWorkflowFrontmatter(workflowPath);
  if (!fm) throw new Error(`Invalid WORKFLOW.md in ${workflowPath}`);
  const body = getWorkflowBody(workflowPath) || fm.description;
  const frontmatter = yaml.stringify({
    description: fm.description,
    name: fm.name || name,
    [KIMI_WORKFLOW_MARKER]: name,
  }).trim();
  return `---\n${frontmatter}\n---\n\n${body.trim()}\n`;
}

export function transformWorkflowForOpenClaw(workflowPath: string, name: string): string {
  const fm = parseWorkflowFrontmatter(workflowPath);
  if (!fm) throw new Error(`Invalid WORKFLOW.md in ${workflowPath}`);
  const body = getWorkflowBody(workflowPath) || fm.description || name;
  return yaml.stringify({
    name: fm.name || name,
    args: {
      agent: {
        default: 'main',
      },
      prompt: {
        default: '',
      },
    },
    env: {
      [OPENCLAW_WORKFLOW_MARKER_ENV]: name,
      AGENTS_WORKFLOW_DESCRIPTION: fm.description || name,
      AGENTS_WORKFLOW_BODY: body.trim(),
    },
    steps: [
      {
        id: 'run_openclaw',
        command: 'openclaw agent --agent "$LOBSTER_ARG_AGENT" --message "$(printf \'%s\\n\\n%s\\n\' "$AGENTS_WORKFLOW_BODY" "$LOBSTER_ARG_PROMPT")"',
      },
    ],
  });
}

export const GROK_WORKFLOW_MARKER = 'agents_workflow';

function escapeRhaiString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

export function transformWorkflowForGrok(workflowPath: string, name: string): string {
  const fm = parseWorkflowFrontmatter(workflowPath);
  if (!fm) throw new Error(`Invalid WORKFLOW.md in ${workflowPath}`);
  const body = getWorkflowBody(workflowPath);
  const description = (fm.description || name).trim();
  const instructions = (body || description).trim();

  return [
    `// ${GROK_WORKFLOW_MARKER}: ${name}`,
    `// Managed by agents-cli — re-sync from ~/.agents/workflows/${name}/; do not edit by hand.`,
    `let meta = #{`,
    `    name: "${escapeRhaiString(name)}",`,
    `    description: "${escapeRhaiString(description)}",`,
    `    phases: [ #{ title: "Run", detail: "orchestrator" } ],`,
    `};`,
    ``,
    `let user_prompt = if args == () { () } else if type_of(args) == "string" { args } else { args.prompt };`,
    `if user_prompt == () { pause("verification", "Pass a prompt as args.prompt or a string arg."); }`,
    ``,
    `phase("Run");`,
    `let instructions = "${escapeRhaiString(instructions)}";`,
    `let prompt = instructions + "\\n\\n---\\n\\nUser request:\\n" + user_prompt;`,
    `let r = agent(prompt, #{ label: "orchestrator", capability_mode: "all" });`,
    `if r != () && r.success { complete(r.output); }`,
    `complete(#{ summary: "workflow failed", error: if r == () { "no result" } else { "agent failed" } });`,
    ``,
  ].join('\n');
}

export function grokWorkflowMarker(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(new RegExp(`^//\\s*${GROK_WORKFLOW_MARKER}:\\s*(\\S+)`, 'm'));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function expandWorkflowPath(ref: string): string {
  if (ref === '~') return process.env.HOME ?? ref;
  if (ref.startsWith('~/')) {
    const home = process.env.HOME;
    return home ? path.join(home, ref.slice(2)) : ref;
  }
  return ref;
}

function isWorkflowDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'WORKFLOW.md'));
}

function resolveWorkflowPath(ref: string, cwd: string): string | null {
  const expanded = expandWorkflowPath(ref);
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  return isWorkflowDir(candidate) ? candidate : null;
}

function pluginMarketplaceDirs(cwd: string): string[] {
  const pluginsDirs: string[] = [];
  const projectPlugins = getProjectPluginsDir(cwd);
  if (projectPlugins) pluginsDirs.push(projectPlugins);
  pluginsDirs.push(getPluginsDir(), getSystemPluginsDir());
  for (const extra of getEnabledExtraRepos()) {
    pluginsDirs.push(path.join(extra.dir, 'plugins'));
  }
  return pluginsDirs;
}

function isPluginDirectory(pluginRoot: string, entry: fs.Dirent): boolean {
  if (entry.name.startsWith('.')) return false;
  let isDir = entry.isDirectory();
  if (!isDir && entry.isSymbolicLink()) {
    try {
      isDir = fs.statSync(pluginRoot).isDirectory();
    } catch {
      isDir = false;
    }
  }
  return isDir;
}

export function listPluginWorkflowDirs(
  cwd: string = process.cwd(),
  pluginName?: string,
): string[] {
  const pluginRoots: string[] = [];

  for (const pluginsDir of pluginMarketplaceDirs(cwd)) {
    if (!fs.existsSync(pluginsDir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (pluginName !== undefined && entry.name !== pluginName) continue;
      const pluginRoot = path.join(pluginsDir, entry.name);
      if (!isPluginDirectory(pluginRoot, entry)) continue;
      const workflowsDir = path.join(pluginRoot, 'workflows');
      if (fs.existsSync(workflowsDir)) pluginRoots.push(workflowsDir);
    }
  }
  return pluginRoots;
}

export function isBareWorkflowName(ref: string): boolean {
  if (!ref || ref === '.' || ref === '..') return false;
  if (ref.includes('/') || ref.includes('\\')) return false;
  if (ref.includes('..')) return false;
  if (ref.includes('@')) return false;
  if (path.isAbsolute(ref)) return false;
  return path.basename(ref) === ref;
}

interface ParsedWorkflowRef {
  name: string;
  source?: string;
}

export function parseWorkflowRef(ref: string): ParsedWorkflowRef | null {
  let r = ref.trim();
  if (r.startsWith('workflow:')) r = r.slice('workflow:'.length);
  if (!r) return null;

  const at = r.lastIndexOf('@');
  if (at > 0) {
    const name = r.slice(0, at);
    const source = r.slice(at + 1);
    if (!isBareWorkflowName(name) || !isBareWorkflowName(source)) return null;
    return { name, source };
  }
  if (!isBareWorkflowName(r)) return null;
  return { name: r };
}

export function resolveWorkflowRef(ref: string, cwd: string = process.cwd()): string | null {
  const direct = resolveWorkflowPath(ref, cwd);
  if (direct) return direct;

  const parsed = parseWorkflowRef(ref);
  if (!parsed) return null;

  if (parsed.source) {
    for (const dir of listPluginWorkflowDirs(cwd, parsed.source)) {
      const workflowPath = path.join(dir, parsed.name);
      if (isWorkflowDir(workflowPath)) return workflowPath;
    }
    for (const extra of getEnabledExtraRepos()) {
      if (extra.alias !== parsed.source) continue;
      const workflowPath = path.join(extra.dir, 'workflows', parsed.name);
      if (isWorkflowDir(workflowPath)) return workflowPath;
    }
    return null;
  }

  const projectAgentsDir = getProjectAgentsDir(cwd);
  const searchDirs = [
    ...(projectAgentsDir ? [path.join(projectAgentsDir, 'workflows')] : []),
    getUserWorkflowsDir(),
    ...listPluginWorkflowDirs(cwd),
    ...getEnabledExtraRepos().map(r => path.join(r.dir, 'workflows')),
    getSystemWorkflowsDir(),
  ];

  for (const dir of searchDirs) {
    const workflowPath = path.join(dir, parsed.name);
    if (isWorkflowDir(workflowPath)) return workflowPath;
  }
  return null;
}

export function discoverWorkflowsFromRepo(repoPath: string): DiscoveredWorkflow[] {
  const results: DiscoveredWorkflow[] = [];

  if (fs.existsSync(path.join(repoPath, 'WORKFLOW.md'))) {
    const frontmatter = parseWorkflowFrontmatter(repoPath);
    if (frontmatter) {
      return [{
        name: path.basename(repoPath),
        path: repoPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(repoPath),
      }];
    }
  }

  const workflowsSubdir = path.join(repoPath, 'workflows');
  const scanDir = fs.existsSync(workflowsSubdir) ? workflowsSubdir : repoPath;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const workflowPath = path.join(scanDir, entry.name);
    const frontmatter = parseWorkflowFrontmatter(workflowPath);
    if (frontmatter) {
      results.push({
        name: entry.name,
        path: workflowPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(workflowPath),
      });
    }
  }

  return results;
}

export function listInstalledWorkflows(cwd: string = process.cwd()): Map<string, InstalledWorkflow> {
  const result = new Map<string, InstalledWorkflow>();
  const extraRepos = getEnabledExtraRepos();

  const searchDirs = [
    getUserWorkflowsDir(),
    ...listPluginWorkflowDirs(cwd),
    ...extraRepos.map(r => path.join(r.dir, 'workflows')),
    getSystemWorkflowsDir(),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (result.has(entry.name)) continue;

      const workflowPath = path.join(dir, entry.name);
      const frontmatter = parseWorkflowFrontmatter(workflowPath);
      if (!frontmatter) continue;

      result.set(entry.name, {
        name: entry.name,
        path: workflowPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(workflowPath),
      });
    }
  }

  return result;
}

export function installWorkflowCentrally(sourcePath: string, name: string): { success: boolean; error?: string } {
  const targetPath = path.join(getUserWorkflowsDir(), name);
  try {
    fs.mkdirSync(getUserWorkflowsDir(), { recursive: true });
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function removeWorkflow(name: string): { success: boolean; error?: string } {
  const sourcePath = path.join(getUserWorkflowsDir(), name);
  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Workflow '${name}' not found in ~/.agents/workflows/` };
  }
  try {
    const trashDir = getTrashWorkflowsDir();
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(sourcePath, path.join(trashDir, `${name}-${Date.now()}`));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function antigravityWorkflowsDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), '.gemini', 'config', 'global_workflows');
}

function parseSubrecipeFrontmatter(filePath: string): { name?: string; description?: string; body: string } {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  if (lines[0] !== '---') return { body: content.trim() };
  const endIndex = lines.slice(1).findIndex(l => l === '---');
  if (endIndex < 0) return { body: content.trim() };
  const frontmatter = lines.slice(1, endIndex + 1).join('\n');
  let parsed: Record<string, unknown> = {};
  try {
    const value = yaml.parse(frontmatter);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {  }
  return {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    body: lines.slice(endIndex + 2).join('\n').trim(),
  };
}

export function selectedWorkflowSubagents(workflowPath: string, allowedAgents?: string[]): string[] {
  const subagentsDir = path.join(workflowPath, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];
  const allowed = allowedAgents ? new Set(allowedAgents) : null;
  return fs.readdirSync(subagentsDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map(e => e.name.slice(0, -'.md'.length))
    .filter(name => !allowed || allowed.has(name))
    .sort();
}

export function writeGooseSubrecipe(workflowPath: string, subrecipeName: string, destDir: string): void {
  const sourcePath = path.join(workflowPath, 'subagents', `${subrecipeName}.md`);
  const parsed = parseSubrecipeFrontmatter(sourcePath);
  const body = parsed.body || parsed.description || subrecipeName;
  const recipe = {
    version: '1.0.0',
    title: parsed.name || subrecipeName,
    description: parsed.description || `Subrecipe for ${subrecipeName}`,
    instructions: body,
    prompt: body,
  };
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, `${subrecipeName}.yaml`), yaml.stringify(recipe), 'utf-8');
}

export function renderGooseRecipeYaml(workflowPath: string, name: string): string | null {
  const frontmatter = parseWorkflowFrontmatter(workflowPath);
  if (!frontmatter) return null;
  const body = readWorkflowBody(workflowPath) || frontmatter.description || name;
  const subagents = selectedWorkflowSubagents(workflowPath, frontmatter.allowedAgents);
  const recipe: Record<string, unknown> = {
    version: '1.0.0',
    title: frontmatter.name || name,
    description: frontmatter.description || name,
    instructions: body,
    prompt: body,
  };
  if (frontmatter.model) {
    recipe.settings = { goose_model: frontmatter.model };
  }
  if (subagents.length > 0) {
    recipe.sub_recipes = subagents.map(subagentName => ({
      name: subagentName,
      path: `./${name}.subrecipes/${subagentName}.yaml`,
      description: `Workflow subrecipe ${subagentName}`,
    }));
  }
  return yaml.stringify(recipe);
}

function parseSkillFrontmatter(filePath: string): Record<string, unknown> | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  const endIndex = lines.slice(1).findIndex(l => l === '---');
  if (endIndex < 0) return null;
  const frontmatter = lines.slice(1, endIndex + 1).join('\n');
  const parsed = yaml.parse(frontmatter);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function kimiWorkflowMarker(filePath: string): string | null {
  try {
    const fm = parseSkillFrontmatter(filePath) as { type?: unknown; agents_workflow?: unknown } | null;
    return fm?.type === 'flow' && typeof fm.agents_workflow === 'string' ? fm.agents_workflow : null;
  } catch {
    return null;
  }
}

export function antigravityWorkflowMarker(filePath: string): string | null {
  try {
    const fm = parseSkillFrontmatter(filePath) as { agents_workflow?: unknown } | null;
    return typeof fm?.agents_workflow === 'string' ? fm.agents_workflow : null;
  } catch {
    return null;
  }
}

export function openclawWorkflowMarker(filePath: string): string | null {
  try {
    const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as { env?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
      return null;
    }
    const marker = (parsed.env as Record<string, unknown>)[OPENCLAW_WORKFLOW_MARKER_ENV];
    return typeof marker === 'string' ? marker : null;
  } catch {
    return null;
  }
}

export function iterWorkflowsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const result: Array<{ agent: AgentId; version: string }> = [];
  for (const agentId of capableAgents('workflows')) {
    if (filter?.agent && filter.agent !== agentId) continue;
    const versions = listInstalledVersions(agentId);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      if (!supports(agentId, 'workflows', version).ok) continue;
      result.push({ agent: agentId, version });
    }
  }
  return result;
}
