/**
 * Workflow management library.
 *
 * Workflows are directory bundles with a WORKFLOW.md containing YAML frontmatter.
 * They optionally contain subagents/, skills/, and plugins/ subdirectories that
 * are composed at runtime by `agents run <workflow>`.
 */

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

// WORKFLOW_CAPABLE_AGENTS removed — use `capableAgents('workflows')` from
// lib/capabilities.ts. The capability matrix on AgentConfig is the single
// source of truth.

/**
 * The `loop:` block as it appears in WORKFLOW.md frontmatter (YAML, snake_case).
 * Parsed defensively and translated to the camelCase LoopConfig the driver
 * consumes (src/lib/loop.ts). See docs/execution.md.
 */
export interface LoopConfigRaw {
  /** Stop condition. Only `signal` is supported today. */
  until?: 'signal';
  /** Hard cap on iterations. */
  max_iterations?: number;
  /** Token hard-cap, enforced outside the agent. */
  budget?: number;
  /** Delay between iterations ("0" back-to-back, "30m" paces). */
  interval?: string;
}

/**
 * The `verify:` sub-block of a `for_each:` construct (issue #343).
 *
 * Each produced item's stage teammate can be gated by a panel of independent
 * skeptics: `votes` of them run (as teammates that depend on the stage), and
 * `keep_if` records how their verdicts converge (`majority` / `all` / `any`).
 * The vote-counting itself is a downstream concern — the declarative layer's
 * job is to expand the panel; see `expandForEach`.
 */
export interface ForEachVerifySpec {
  /** Subagent / agent id that plays skeptic for each item. */
  agent: string;
  /** Prompt template for each skeptic (`{{item}}`, `{{index}}` substituted). */
  prompt?: string;
  /** How many independent skeptics run per item (>= 1). */
  votes: number;
  /** Convergence rule for keeping a finding. */
  keep_if: 'majority' | 'all' | 'any';
}

/**
 * The `for_each:` block as it appears in WORKFLOW.md frontmatter (issue #343).
 *
 * Declarative dynamic fan-out: a producer emits a list at runtime, one stage
 * teammate runs per produced item (runtime-computed N), optionally followed by
 * a `verify` panel. This is a thin declarative layer over the existing teams
 * substrate — each expanded teammate is staged into the supervisor's
 * mid-flight-add path (`AgentManager.spawn`), NOT a new engine. See
 * `expandForEach` and `src/lib/teams/forEach.ts`.
 *
 * Parsed defensively (mirrors `parseLoopBlock`): a malformed block drops to
 * undefined rather than passing a bad shape downstream.
 */
export interface ForEachSpec {
  /**
   * The producer: a shell command or subagent whose stdout is a JSON array (or
   * newline-delimited list) of items. Alternatively `itemsRef` names a prior
   * step's output. At least one of the two is expected for a runnable spec.
   */
  produce?: string;
  /** `${step}`-style reference to a prior step's produced list. */
  itemsRef?: string;
  /** Subagent / agent id for the per-item stage. */
  agent: string;
  /** Base name for the expanded teammates (default `item`). */
  name?: string;
  /** Per-item prompt template (`{{item}}`, `{{index}}` substituted). */
  prompt: string;
  /** In-flight cap — maps to the supervisor's wave size (>= 1). */
  concurrency?: number;
  /**
   * Hard runaway guard: the producer can emit at most this many items before
   * the fan-out is truncated. Defaults to `DEFAULT_FOR_EACH_CAP`.
   */
  max_items?: number;
  /** Optional convergence gate run after each item's stage. */
  verify?: ForEachVerifySpec;
}

/**
 * Hard upper bound on items a single `for_each` expands, absent an explicit
 * `max_items`. A guard against a runaway producer spawning unbounded teammates
 * (acceptance criterion in issue #343). Anthropic's Dynamic Workflows cap at
 * 1000; we default lower and let authors raise it deliberately.
 */
export const DEFAULT_FOR_EACH_CAP = 256;

/** Parsed WORKFLOW.md frontmatter. */
export interface WorkflowFrontmatter {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  allowedAgents?: string[];
  /**
   * Secrets bundle names this workflow needs (e.g. `linear.app`, `github.com`).
   * When `agents run <workflow>` resolves a workflow, these are unioned into the
   * effective `--secrets` list and resolved from the macOS Keychain before spawn.
   * Pass `--no-auto-secrets` to skip this injection.
   */
  secrets?: string[];
  /**
   * Optional loop block: wraps the workflow in a bounded until-condition loop
   * (issue #332). When present, `agents run <workflow>` honors it without a
   * `--loop` flag. Validated/coerced in parseWorkflowFrontmatter.
   */
  loop?: LoopConfigRaw;
  /**
   * Optional declarative dynamic fan-out (issue #343): a producer emits a list
   * and one stage teammate runs per item, with an optional verify panel.
   * Validated/coerced in parseWorkflowFrontmatter via `parseForEachBlock`.
   */
  forEach?: ForEachSpec;
}

/** A workflow found during repo discovery. */
interface DiscoveredWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

/** A workflow in central storage (~/.agents/workflows/ or ~/.agents/.system/workflows/). */
export interface InstalledWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

/** Parse WORKFLOW.md frontmatter from a workflow directory. Returns null if invalid. */
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

    // Capability-scoping fields are wired into the run (see src/commands/exec.ts);
    // coerce to string arrays defensively so a malformed `tools: foo` (scalar) or
    // `tools: [Read, 3]` (mixed) never reaches buildExecCommand as a bad shape.
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

/**
 * Defensively coerce a frontmatter `loop:` value into a LoopConfigRaw.
 *
 * Mirrors the asStringArray discipline above: a malformed field is dropped to
 * undefined rather than passed through, so the loop driver never sees a bad
 * shape. Returns undefined when `loop:` is absent or not an object, or when no
 * recognized field survives coercion (an all-garbage block is treated as
 * "no loop", not "empty loop").
 *
 * Field rules:
 *   - until:          only the literal `signal` is accepted; anything else dropped.
 *   - max_iterations: a finite positive integer; non-numbers/<=0 dropped.
 *   - budget:         a finite positive number (tokens); non-numbers/<=0 dropped.
 *   - interval:       a string (e.g. "0", "30m"); non-strings dropped.
 */
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

/** A finite positive integer, or undefined. Shared guard for count-like fields. */
function asPosInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0
    ? v
    : undefined;
}

/** A non-empty trimmed string, or undefined. */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * Defensively coerce a frontmatter `verify:` sub-block into a ForEachVerifySpec.
 *
 * Requires an `agent`; drops the whole block otherwise (a verify panel with no
 * skeptic is meaningless). `votes` defaults to 1 (a single confirmation) and
 * `keep_if` to `majority`; both are validated against their allowed shapes.
 */
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

/**
 * Defensively coerce a frontmatter `for_each:` block into a ForEachSpec (issue
 * #343). Mirrors `parseLoopBlock`'s discipline: a block missing the two
 * load-bearing fields (`agent` + `prompt`) drops to undefined rather than
 * passing a half-formed spec to the expander. Optional numeric/verify fields
 * are individually validated and dropped when malformed.
 */
export function parseForEachBlock(v: unknown): ForEachSpec | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;

  const agent = asNonEmptyString(raw.agent);
  const prompt = asNonEmptyString(raw.prompt);
  if (!agent || !prompt) return undefined;

  const out: ForEachSpec = { agent, prompt };

  const produce = asNonEmptyString(raw.produce);
  if (produce) out.produce = produce;
  // `for_each: ${step}` references a prior step's list. Accept either the
  // snake-case `for_each` key or an explicit `items_ref`.
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

/** One teammate produced by expanding a `for_each` spec against a produced list. */
export interface ForEachTeammate {
  /** `stage` runs the per-item work; `verify` is a skeptic in the panel. */
  role: 'stage' | 'verify';
  /** Unique teammate name within the team (used for `--after` linkage). */
  name: string;
  /** Subagent / agent id this teammate runs as. */
  agentType: string;
  /** Fully-resolved prompt (template variables already substituted). */
  prompt: string;
  /** Names of sibling teammates this one waits on (`--after` semantics). */
  after: string[];
  /** The produced item this teammate handles. */
  item: string;
  /** Zero-based index of the item in the (capped) produced list. */
  itemIndex: number;
  /** For `verify` teammates: 1-based vote index and the panel's gate config. */
  vote?: number;
  votes?: number;
  keep_if?: 'majority' | 'all' | 'any';
}

/** Result of expanding a `for_each` spec: the teammates plus cap accounting. */
interface ForEachExpansion {
  teammates: ForEachTeammate[];
  /** How many items the producer emitted (pre-cap). */
  producedCount: number;
  /** How many items were actually expanded (post-cap). */
  usedCount: number;
  /** producedCount - usedCount; > 0 means the runaway guard truncated. */
  truncated: number;
  /** The effective per-`for_each` item cap that was applied. */
  cap: number;
}

/**
 * Substitute `{{item}}` / `{{index}}` (and 1-based `{{n}}`) in a prompt
 * template. Unknown `{{...}}` tokens are left intact so a template can carry
 * placeholders the caller resolves elsewhere.
 */
export function renderForEachTemplate(template: string, item: string, index: number): string {
  return template
    .replace(/\{\{\s*item\s*\}\}/g, item)
    .replace(/\{\{\s*index\s*\}\}/g, String(index))
    .replace(/\{\{\s*n\s*\}\}/g, String(index + 1));
}

/**
 * Expand a `for_each` spec against a producer's output into concrete teammate
 * descriptors (issue #343) — the heart of the declarative fan-out.
 *
 * Pure and deterministic: no I/O, no spawning. `src/lib/teams/forEach.ts`
 * feeds the result to `AgentManager.spawn`, staging each descriptor into the
 * supervisor's existing mid-flight-add path — so this reuses the dynamic-DAG
 * substrate rather than introducing a new engine.
 *
 * For N produced items (capped at `spec.max_items` / `DEFAULT_FOR_EACH_CAP`):
 *   - one `stage` teammate per item, depending on `producerName` if given;
 *   - when `verify` is set, `votes` `verify` teammates per item, each
 *     depending on that item's stage teammate.
 *
 * Names are unique (`<base>-<n>` and `<base>-<n>-verify-<v>`) so `--after`
 * linkage and the teams cycle check carry over unchanged.
 */
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

/**
 * Decide which subagent .md stems a workflow may use, given the discovered
 * subagent files and the parsed `allowedAgents` frontmatter. This is the
 * fail-closed security boundary for issue #324:
 *
 *   - `allowedAgents === undefined` (field absent)  -> NO restriction; allow all.
 *   - `allowedAgents === []`        (present, empty) -> allow ZERO; copy none.
 *   - `allowedAgents = [a, b]`                       -> allow only those stems.
 *
 * An explicit empty array must NEVER widen to "allow all" — that would copy
 * every subagent definition into the run, granting MORE access than declared.
 *
 * `available` are the .md filenames found in subagents/ (e.g. `security.md`).
 * Returns the stems to copy and any allowedAgents entries with no matching file.
 */
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

/** The Claude tool an orchestrator uses to dispatch subagents. Must stay in a
 *  workflow's `--tools` allowlist whenever the workflow ships dispatchable
 *  subagents, or the orchestrator has no way to reach them. */
const SUBAGENT_DISPATCH_TOOL = 'Task';

/**
 * Keep the subagent-dispatch tool (`Task`) in a `tools:`-restricted workflow's
 * allowlist when the workflow actually ships subagents to dispatch.
 *
 * A WORKFLOW.md `tools:` list becomes Claude's `--tools` set, which *restricts*
 * the available built-ins. An orchestrator whose `subagents/` files were just
 * copied into the shared agents dir but whose `tools:` omits `Task` cannot
 * reach any of them — it silently no-ops (observed: the run emits only "I'll
 * wait for the completion notification" and exits). Omitting `Task` while
 * shipping a `subagents/` dir is always an authoring miss, so we re-add it at
 * the source rather than relying on every workflow author to remember.
 *
 * Returns `tools` unchanged when the workflow has no subagents or already lists
 * `Task`; otherwise appends `Task`.
 */
export function ensureSubagentDispatchTool(tools: string[], hasSubagents: boolean): string[] {
  if (!hasSubagents || tools.includes(SUBAGENT_DISPATCH_TOOL)) return tools;
  return [...tools, SUBAGENT_DISPATCH_TOOL];
}

/**
 * Prune stale workflow-managed subagent files from the shared per-agent agents
 * dir before a scoped run writes the permitted set (issue #401, follow-up to
 * #324). A prior *unrestricted* run of a workflow copies every subagent
 * definition into the shared `~/.claude/agents/` dir; a later run that declares
 * `allowedAgents:` copies only the permitted ones but never removes the
 * leftovers — so an unlisted subagent stays on disk and remains dispatchable,
 * silently defeating the fail-closed scope.
 *
 * Fail-closed fix (mirrors how `cleanupWorkflowMcpConfig` only tears down what
 * the workflow itself created): remove any file that (a) belongs to THIS
 * workflow's subagents/ — matched by filename, i.e. the workflow-managed
 * universe — and (b) is NOT in the permitted set. A user's own hand-placed
 * subagent shares no name with a workflow subagent file, so it is never
 * touched. Permitted files are left in place; the caller (re)copies them.
 *
 * `workflowSubagentFiles` are the .md filenames in the workflow's subagents/
 * dir (e.g. `security.md`); `allowedStems` are the permitted stems from
 * `resolveAllowedSubagents`. Returns the filenames actually removed.
 */
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
    if (allow.has(stem)) continue; // permitted → the copy step will (re)write it
    const target = path.join(sharedAgentsDir, file);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      pruned.push(file);
    }
  }
  return pruned;
}

/** Count subagent .md files in a workflow's subagents/ directory. */
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

/** Convert a canonical agents-cli workflow bundle into a Kimi flow skill. */
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

/**
 * Convert a canonical agents-cli workflow bundle into an Antigravity workflow
 * markdown file. Antigravity discovers workflows as flat `<name>.md` files under
 * `~/.gemini/config/global_workflows/` (scanned by `agy` at startup) and exposes
 * each as a `/<name>` slash command. Frontmatter carries the required `description`
 * plus the shared `agents_workflow` ownership marker so agents-cli never clobbers a
 * user-authored workflow of the same name.
 */
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

/** Convert a canonical agents-cli workflow bundle into an OpenClaw Lobster file. */
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

/** Marker comment prefix written into agents-cli-managed Grok `.rhai` files. */
export const GROK_WORKFLOW_MARKER = 'agents_workflow';

/** Escape a string for embedding inside a Rhai double-quoted literal. */
function escapeRhaiString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

/**
 * Convert a canonical agents-cli workflow bundle into a Grok native Rhai
 * workflow script. Grok discovers saved workflows as
 * `~/.grok/workflows/<name>.rhai` (and project `.grok/workflows/`) and exposes
 * each as a `/<name>` slash command (enabled by default since v0.2.111).
 *
 * The projection is a single-agent orchestrator that feeds the WORKFLOW.md
 * body as the agent prompt plus the caller's `args.prompt` (or string args).
 * Multi-phase fan-out is left to hand-authored Rhai — agents-cli's job is to
 * land the orchestrator instructions in the native path.
 */
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

/** Read the agents_workflow marker from a Grok `.rhai` file, if present. */
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

/** Plugin-root marketplace dirs in project → user → system → extra order. */
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

/**
 * Plugin `workflows/` directories in discovery order (project → user → system →
 * extra). Used by name resolution and listing so a plugin-packaged workflow is
 * runnable via `agents run <name>` without a separate install into
 * ~/.agents/workflows/ (Phase 5 packaging). Within the plugin band, project
 * plugins beat user/system plugins (same first-hit-wins as other layers).
 *
 * Pass `pluginName` to restrict to one plugin (for `name@plugin` resolution).
 */
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

/**
 * True when `ref` is a single bare workflow / source identifier (no path
 * separators, no `..`, no `@`). Name lookup must not path-join multi-segment
 * or traversal refs into search roots. `name@source` is parsed separately.
 */
export function isBareWorkflowName(ref: string): boolean {
  if (!ref || ref === '.' || ref === '..') return false;
  if (ref.includes('/') || ref.includes('\\')) return false;
  if (ref.includes('..')) return false;
  if (ref.includes('@')) return false;
  // Reject absolute paths (posix or Windows).
  if (path.isAbsolute(ref)) return false;
  return path.basename(ref) === ref;
}

/** Parsed `agents run` workflow reference (docs/07-entrypoints). */
interface ParsedWorkflowRef {
  /** Workflow directory name (WORKFLOW.md parent). */
  name: string;
  /**
   * When set (`name@source`), pin resolution to that source only:
   * a plugin name, or an enabled extra-repo alias.
   */
  source?: string;
}

/**
 * Parse a workflow run target: optional `workflow:` type prefix and optional
 * `@source` pin. Returns null when the form is not a valid name lookup.
 */
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

/**
 * Resolve an `agents run <workflow>` reference.
 *
 * Directories are accepted anywhere on disk when they contain WORKFLOW.md.
 * Name lookup precedence (docs/07-entrypoints): project > user > plugin > extra > system.
 * Pin a source with `name@plugin` or `name@extra-alias` (optional `workflow:` prefix).
 */
export function resolveWorkflowRef(ref: string, cwd: string = process.cwd()): string | null {
  const direct = resolveWorkflowPath(ref, cwd);
  if (direct) return direct;

  const parsed = parseWorkflowRef(ref);
  if (!parsed) return null;

  // Source-qualified: only that plugin or extra-repo workflows/ (no layered fallback).
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

/**
 * Discover all workflow directories (those containing WORKFLOW.md) in a local path.
 * Checks if the path itself is a workflow, then scans a top-level workflows/ subdirectory,
 * then falls back to scanning all immediate subdirectories.
 */
export function discoverWorkflowsFromRepo(repoPath: string): DiscoveredWorkflow[] {
  const results: DiscoveredWorkflow[] = [];

  // The path itself may be a single workflow directory.
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

  // Try a workflows/ subdirectory first, then fall back to scanning root subdirectories.
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

/**
 * List all workflows in central storage + plugin packages.
 * Precedence: user > plugin > extra > system (first writer wins; project is
 * cwd-scoped and handled by resolveWorkflowRef / the resource handler).
 */
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
      if (result.has(entry.name)) continue; // Higher-priority layer already present

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

/** Copy a workflow directory into user central storage (~/.agents/workflows/<name>/). */
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

/** Move a workflow from user central storage to trash. */
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

/**
 * Antigravity user workflows are NOT version-isolated. `agy` scans a single,
 * shared, HOME-global directory at startup — `~/.gemini/config/global_workflows/`
 * — and that dir is a real directory in the user's home, never symlinked into a
 * per-version home (only `~/.gemini/antigravity-cli` is version-scoped). Writing
 * into a version home therefore lands somewhere agy never reads. So every
 * antigravity version resolves to the same real shared dir; `versionHome` is
 * intentionally ignored. (Verified via strace of `agy`: it opens
 * `$HOME/.gemini/config/global_workflows/<name>.md` and never the version home.)
 */
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
  } catch { /* ignore malformed subagent frontmatter */ }
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

/**
 * Render the main Goose recipe YAML for a workflow — the exact bytes the Goose
 * `WORKFLOW_TARGETS` entry writes to `<name>.yaml`. Extracted so the writer and
 * the doctor content-drift check (`matches`) render from ONE source and can
 * never disagree. Returns null on invalid frontmatter.
 */
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

/** Iterate all installed (agent, version) pairs that support workflows. */
export function iterWorkflowsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const result: Array<{ agent: AgentId; version: string }> = [];
  for (const agentId of capableAgents('workflows')) {
    if (filter?.agent && filter.agent !== agentId) continue;
    const versions = listInstalledVersions(agentId);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      // Honour version floors (e.g. grok workflows since 0.2.111).
      if (!supports(agentId, 'workflows', version).ok) continue;
      result.push({ agent: agentId, version });
    }
  }
  return result;
}
