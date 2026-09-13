/**
 * Permission management for AI coding agents.
 *
 * Provides a canonical permission format (PermissionSet with allow/deny rules)
 * and converters to/from each agent's native format (Claude settings.json,
 * OpenCode opencode.jsonc, Codex config.toml + .rules). Handles discovery,
 * installation, removal, and merging of permission groups stored in
 * ~/.agents/permissions/groups/.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import type {
  AgentId,
  PermissionSet,
  InstalledPermission,
  ClaudePermissions,
  CursorPermissions,
  OpenCodePermissions,
  CodexPermissions,
} from './types.js';
import { getPermissionsDir, getUserPermissionsDir, ensureAgentsDir } from './state.js';
import { safeJoin } from './paths.js';
import { AGENTS, agentConfigDirName } from './agents.js';
import { supports } from './capabilities.js';
import { updateGeminiSettings } from './gemini-settings.js';
// The canonical<->native tool vocabularies live in the registry, which also owns
// the reverse projections — so the serializers below and the readers there can
// never disagree about what `fs_read` or `developer__shell` means.
import {
  ANTIGRAVITY_ACTION_BY_TOOL,
  CANONICAL_TO_OPENCLAW_TOOL,
  CODEX_RULES_FILENAME,
  stripJsonComments,
  GROK_TOOL_BY_CANONICAL,
  PERMISSION_TARGETS,
  readCanonicalPermissions,
} from './permissions-registry.js';

export { CODEX_RULES_FILENAME };

const HOME = os.homedir();

// PERMISSIONS_CAPABLE_AGENTS removed — use `capableAgents('allowlist')`
// from lib/capabilities.ts. The capability matrix on AgentConfig is the
// single source of truth. (Per-agent native format details:
//   antigravity → ~/.gemini/antigravity-cli/settings.json `permissions.{allow,deny}`
//   grok        → ~/.grok/config.toml `[permission].rules`
// the writer in `applyPermissionsToVersion` handles the format dispatch.)

export type ParsedRules = PermissionSet;

export const COMPUTER_PERMISSION_RULE_PREFIX = 'Computer';

export const COMPUTER_APP_GATED_VERBS = [
  'screenshot',
  'describe',
  'get-text',
  'launch',
  'raise',
  'click',
  'right-click',
  'type',
  'type-text',
  'key',
  'drag',
  'scroll',
  'ax-action',
  'focus',
  'wait',
] as const;

export const COMPUTER_INPUT_GATED_VERBS = [
  'raise',
  'click',
  'right-click',
  'type',
  'type-text',
  'key',
  'drag',
  'scroll',
  'ax-action',
  'focus',
] as const;

export function formatComputerPermissionGrantHint(bundleId?: string): string {
  const target = bundleId && bundleId.length > 0 ? bundleId : '<bundle-id>';
  return `add Computer(${target}) to a permissions group, then \`agents computer reload\`\n` +
    `app-targeted computer verbs are gated by Computer(<bundle-id>): ${COMPUTER_APP_GATED_VERBS.join(', ')}`;
}

export function containsBroadGrants(rules: ParsedRules): { broad: string[]; reason: string } | null {
  const broad: string[] = [];
  const reasons = new Set<string>();

  for (const perm of rules.allow) {
    if (BLANKET_BASH_FORMS.has(perm)) {
      broad.push(perm);
      reasons.add('allows any bash command and maps Codex to approval_policy=never');
      continue;
    }
    const parsed = parseCanonicalPattern(perm);
    if (!parsed) continue;
    if (parsed.tool === 'bash' && (parsed.pattern === '*' || parsed.pattern === '**')) {
      broad.push(perm);
      reasons.add('allows any bash command and maps Codex to approval_policy=never');
    } else if (parsed.tool === 'bash' && parsed.pattern.startsWith('/') && parsed.pattern.includes('*')) {
      broad.push(perm);
      reasons.add('allows wildcard absolute bash paths');
    } else if ((parsed.tool === 'write' || parsed.tool === 'read') && (parsed.pattern === '*' || parsed.pattern === '**')) {
      broad.push(perm);
      reasons.add(`allows broad ${parsed.tool} filesystem access`);
    }
  }

  for (const dir of rules.additionalDirectories || []) {
    if (dir.startsWith('/') || dir.startsWith('~/') || dir === '~' || dir.split(/[\\/]/).includes('..')) {
      broad.push(`additionalDirectories:${dir}`);
      reasons.add('adds a broad or parent-traversing sandbox directory');
    }
  }

  if (broad.length === 0) return null;
  return { broad, reason: Array.from(reasons).join('; ') };
}

/**
 * Convert canonical deny rules to Codex Starlark .rules format.
 * E.g. "Bash(git reset:*)" -> prefix_rule(pattern=["git", "reset"], decision="forbidden")
 *
 * Inverse: `toCanonical` for `PERMISSION_TARGETS.codex` reads
 * `.codex/rules/agents-deny.rules` back into `Bash(<parts>:*)`.
 */
export function convertDenyToCodexRules(deny: string[]): string | null {
  const rules: string[] = [];

  for (const perm of deny) {
    const parsed = parseCanonicalPattern(perm);
    if (!parsed || parsed.tool !== 'bash') continue;

    // Pattern format: "command arg1 arg2:*" or "command:*"
    const command = parsed.pattern.replace(/:?\*$/, '').trim();
    if (!command) continue;

    const parts = command.split(/\s+/);
    const patternStr = parts.map(p => JSON.stringify(p)).join(', ');
    rules.push(`prefix_rule(\n    pattern = [${patternStr}],\n    decision = "forbidden",\n)`);
  }

  if (rules.length === 0) return null;

  return `# Auto-generated by agents-cli from deny permission groups.\n# Do not edit manually — re-run "agents use" to regenerate.\n\n${rules.join('\n\n')}\n`;
}

/**
 * Write `.codex/rules/agents-deny.rules` to match `deny`, or delete it when
 * the current set has nothing to forbid. The reader (PHNX-2703) now surfaces
 * this file, so a later apply with an empty deny must not leave a stale
 * forbid behind — `agents permissions list codex` would keep reporting it.
 */
function syncCodexDenyRules(configDir: string, deny: string[] | undefined): void {
  const rulesPath = path.join(configDir, 'rules', CODEX_RULES_FILENAME);
  const rulesContent = deny && deny.length > 0 ? convertDenyToCodexRules(deny) : null;
  if (rulesContent) {
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, rulesContent, 'utf-8');
    return;
  }
  if (fs.existsSync(rulesPath)) {
    fs.unlinkSync(rulesPath);
  }
}

/**
 * Ensure central permissions directory exists.
 */
function ensurePermissionsDir(): void {
  const groupsDir = path.join(getUserPermissionsDir(), 'groups');
  if (!fs.existsSync(groupsDir)) {
    fs.mkdirSync(groupsDir, { recursive: true });
  }
}

/**
 * Parse a permission set from a YAML file.
 */
export function parsePermissionSet(filePath: string): PermissionSet | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return {
      name: parsed.name || path.basename(filePath, path.extname(filePath)),
      description: parsed.description,
      allow: Array.isArray(parsed.allow) ? parsed.allow : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny : [],
      additionalDirectories: Array.isArray(parsed.additionalDirectories) ? parsed.additionalDirectories : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Discover permission sets from a repository.
 */
export function discoverPermissionsFromRepo(repoPath: string): Array<{ name: string; path: string; set: PermissionSet }> {
  const results: Array<{ name: string; path: string; set: PermissionSet }> = [];

  // Look for permissions in common locations
  const searchPaths = [
    path.join(repoPath, 'permissions'),
    path.join(repoPath, 'agent-permissions'),
    repoPath,
  ];

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

        const filePath = path.join(searchPath, entry.name);
        const set = parsePermissionSet(filePath);
        if (set) {
          results.push({
            name: set.name,
            path: filePath,
            set,
          });
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return results;
}

/**
 * Permission group info with rule count.
 */
export interface PermissionGroupInfo {
  name: string;        // e.g., "02-node"
  ruleCount: number;   // number of allow rules in this group
  path: string;        // full path to the group file
}

/**
 * Discover permission groups from ~/.agents/permissions/groups/.
 * Returns groups with their rule counts.
 */
export function discoverPermissionGroups(): PermissionGroupInfo[] {
  const seen = new Set<string>();
  const groups: PermissionGroupInfo[] = [];

  // Search user dir first, then system (user wins on name collision)
  for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
    const groupsDir = path.join(baseDir, 'groups');
    if (!fs.existsSync(groupsDir)) continue;

    try {
      const entries = fs.readdirSync(groupsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

        const name = entry.name.replace(/\.(yaml|yml)$/, '');
        if (seen.has(name)) continue;
        seen.add(name);

        const filePath = path.join(groupsDir, entry.name);
        let ruleCount = 0;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const matches = content.match(/^\s*-\s*"/gm);
          ruleCount = matches ? matches.length : 0;
        } catch { /* Skip files we can't read */ }

        groups.push({ name, ruleCount, path: filePath });
      }
    } catch { /* Skip inaccessible directory */ }
  }

  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get total rule count across all permission groups.
 */
export function getTotalPermissionRuleCount(): number {
  const groups = discoverPermissionGroups();
  return groups.reduce((sum, g) => sum + g.ruleCount, 0);
}

/**
 * A permission preset recipe — names a preset and lists which groups it composes.
 * Lives at ~/.agents/permissions/presets/<name>.yaml.
 */
export interface PermissionPresetRecipe {
  name: string;
  description?: string;
  includes: string[];
}

/** Env var that selects which set recipe to apply at sync time. */
export const PERMISSION_PRESET_ENV_VAR = 'AGENTS_PERMISSION_PRESET';

/**
 * Read a permission preset recipe by name from ~/.agents/permissions/presets/.
 * Returns null if the recipe file is missing or malformed.
 */
export function readPermissionPresetRecipe(name: string): PermissionPresetRecipe | null {
  const presetsDir = path.join(getPermissionsDir(), 'presets');
  for (const ext of ['.yaml', '.yml']) {
    const filePath = safeJoin(presetsDir, name + ext);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.parse(content);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!Array.isArray(parsed.includes)) return null;
      return {
        name: parsed.name || name,
        description: parsed.description,
        includes: parsed.includes.filter((v: unknown): v is string => typeof v === 'string'),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Return the active permission preset name from AGENTS_PERMISSION_PRESET env var,
 * or null if unset. Caller decides the default behavior when null.
 */
export function getActivePermissionPresetName(): string | null {
  const v = process.env[PERMISSION_PRESET_ENV_VAR];
  return v && v.trim() ? v.trim() : null;
}

/**
 * Build a PermissionSet from selected groups.
 * Concatenates allow/deny rules from each group.
 *
 * Uses line-by-line regex extraction instead of YAML parsing because
 * permission files often contain unescaped nested quotes that break YAML.
 */
export function buildPermissionsFromGroups(groupNames: string[]): PermissionSet {
  const allAllow: string[] = [];
  const allDeny: string[] = [];

  for (const groupName of groupNames) {
    // Search user dir first, then system dir
    let filePath: string | null = null;
    for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
      const groupsDir = path.join(baseDir, 'groups');
      for (const ext of ['.yaml', '.yml']) {
        const candidate = safeJoin(groupsDir, `${groupName}${ext}`);
        if (fs.existsSync(candidate)) { filePath = candidate; break; }
      }
      if (filePath) break;
    }
    if (!filePath) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Extract rules using line-by-line regex (more robust than YAML parsing)
      // Matches lines like: - "Bash(git *)" or   - "WebFetch(domain:example.com)"
      // Handles nested quotes that break YAML parsers.
      // Split on CRLF or LF: git checks group yaml out with CRLF on Windows
      // (core.autocrlf), and a plain split('\n') leaves a trailing '\r' so the
      // closing-quote anchor `"$` never matches — extracting ZERO rules, which
      // wrote an empty permission set and left `agents sync` unable to
      // reconcile permissions on Windows forever (PHNX-3187).
      const lines = content.split(/\r?\n/);
      let section: 'allow' | 'deny' | null = null;
      for (const line of lines) {
        const sectionMatch = line.match(/^\s*(allow|deny)\s*:\s*(?:#.*)?$/);
        if (sectionMatch) {
          section = sectionMatch[1] as 'allow' | 'deny';
          continue;
        }

        // Match: optional whitespace, dash, whitespace, quote, content, quote
        // Use greedy match to capture everything between first and last quote
        const match = line.match(/^\s*-\s*"(.+)"$/);
        if (match) {
          const rule = match[1];
          // 99-deny group rules go to deny, others follow their YAML section.
          // Legacy group files used bare lists with no section; keep those as allow.
          if (section === 'deny' || groupName === '99-deny' || groupName.includes('-deny')) {
            allDeny.push(rule);
          } else {
            allAllow.push(rule);
          }
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  return {
    name: 'built',
    description: `Built from groups: ${groupNames.join(', ')}`,
    allow: allAllow,
    deny: allDeny.length > 0 ? allDeny : undefined,
  };
}

/**
 * List installed permission sets from central storage.
 * User dir takes precedence; system entries are surfaced when user has no
 * same-named override.
 */
export function listInstalledPermissions(): InstalledPermission[] {
  ensureAgentsDir();
  const seen = new Set<string>();
  const results: InstalledPermission[] = [];

  for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
    const dir = path.join(baseDir, 'groups');
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

        const filePath = path.join(dir, entry.name);
        const set = parsePermissionSet(filePath);
        if (!set) continue;
        if (seen.has(set.name)) continue;
        seen.add(set.name);
        results.push({ name: set.name, path: filePath, set });
      }
    } catch {
      // Skip inaccessible directory
    }
  }

  return results;
}

/**
 * Get a specific permission set by name. Searches user groups/ dir first, then system groups/.
 */
function getPermissionSet(name: string): InstalledPermission | null {
  for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
    const dir = path.join(baseDir, 'groups');
    for (const ext of ['.yml', '.yaml']) {
      const filePath = safeJoin(dir, name + ext);
      if (fs.existsSync(filePath)) {
        const set = parsePermissionSet(filePath);
        if (set) {
          return { name: set.name, path: filePath, set };
        }
      }
    }
  }

  return null;
}

/**
 * Install a permission set to user-level central storage.
 */
export function installPermissionSet(
  sourcePath: string,
  name: string
): { success: boolean; error?: string } {
  ensurePermissionsDir();

  const set = parsePermissionSet(sourcePath);
  if (!set) {
    return { success: false, error: 'Invalid permission file' };
  }

  const targetPath = safeJoin(path.join(getUserPermissionsDir(), 'groups'), name + '.yml');

  try {
    fs.copyFileSync(sourcePath, targetPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Remove a permission set from user-level central storage. System-shipped
 * sets are intentionally not deletable from user commands.
 */
export function removePermissionSet(name: string): { success: boolean; error?: string } {
  const groupsDir = path.join(getUserPermissionsDir(), 'groups');

  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(groupsDir, name + ext);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  }

  return { success: false, error: `Permission set '${name}' not found` };
}

// ============================================================================
// Agent-specific converters
// ============================================================================

/**
 * Map a canonical rule to Claude settings.json syntax.
 * Claude's file-permission checks only match Edit(path) rules — an Edit rule
 * covers every file-editing tool (Write, Edit, NotebookEdit) — and Claude
 * warns at startup about unmatched Write(path) rules. Canonical Write(path)
 * stays for other agents' converters; for Claude it is emitted as Edit(path).
 */
function canonicalToClaudeRule(perm: string): string {
  if (perm.startsWith('Write(')) {
    return perm.replace(/^Write/, 'Edit');
  }
  return perm;
}

/**
 * Convert canonical permission set to Claude format.
 * Claude uses: { permissions: { allow: ["Bash(*)", "Read(**)"], deny: [] } }
 */
export function convertToClaudeFormat(set: PermissionSet): ClaudePermissions {
  const permissions: ClaudePermissions['permissions'] = {
    allow: [...new Set(set.allow.map(canonicalToClaudeRule))],
    deny: set.deny ? [...new Set(set.deny.map(canonicalToClaudeRule))] : [],
  };
  if (set.additionalDirectories?.length) {
    permissions.additionalDirectories = [...set.additionalDirectories];
  }
  return { permissions };
}

/**
 * Map a canonical rule to Cursor CLI syntax.
 * Cursor uses Shell(...) instead of Bash(...); other tools keep TitleCase names.
 * https://cursor.com/docs/cli/reference/permissions
 */
function canonicalToCursorRule(perm: string): string {
  if (perm === 'Bash' || perm.startsWith('Bash(')) {
    return perm.replace(/^Bash/, 'Shell');
  }
  // Canonical WebSearch maps to WebFetch family for network allow.
  if (perm.startsWith('WebSearch(')) {
    return perm.replace(/^WebSearch/, 'WebFetch');
  }
  // Cursor has no Edit prefix — file writes use Write(...).
  if (perm === 'Edit' || perm.startsWith('Edit(')) {
    return perm.replace(/^Edit/, 'Write');
  }
  return perm;
}

/**
 * Convert canonical permission set to Cursor CLI format
 * (`~/.cursor/cli-config.json` permissions.allow/deny).
 */
export function convertToCursorFormat(set: PermissionSet): CursorPermissions {
  return {
    permissions: {
      allow: set.allow.map(canonicalToCursorRule),
      deny: (set.deny ?? []).map(canonicalToCursorRule),
    },
  };
}

type CopilotToolApproval =
  | { kind: 'commands'; commandIdentifiers: string[] }
  | { kind: 'read' | 'write' }
  | { kind: 'mcp'; serverName: string; toolName: string | null };

export interface CopilotPermissionsConfig {
  locations: Record<string, {
    tool_approvals?: CopilotToolApproval[];
    allowed_directories?: string[];
  }>;
}

/**
 * Parse canonical permission pattern to extract tool and pattern.
 * "Bash(git *)" -> { tool: "bash", pattern: "git *" }
 * "Read(**)" -> { tool: "read", pattern: "**" }
 */
function parseCanonicalPattern(permission: string): { tool: string; pattern: string } | null {
  const match = permission.match(/^(\w+)\((.+)\)$/);
  if (!match) return null;
  return { tool: match[1].toLowerCase(), pattern: match[2] };
}

/** Blanket-Bash canonical forms that mean "allow any bash command". */
const BLANKET_BASH_FORMS = new Set(['Bash', 'Bash(*)', 'Bash(**)']);

/**
 * Strip Claude's `:*` subcommand-wildcard suffix and return a space-glob form.
 * "mq:*" -> "mq *", "git status" -> "git status", "*" -> "*".
 * Used by serializers whose native pattern grammar uses ` *` instead of `:*`.
 */
function normalizeBashPattern(pattern: string): string {
  if (pattern === '*' || pattern === '**') return '*';
  if (pattern.endsWith(':*')) return pattern.slice(0, -2) + ' *';
  return pattern;
}

function canonicalBashToCopilotCommandIdentifier(pattern: string): string | null {
  if (pattern === '*' || pattern === '**') return null;
  if (pattern.endsWith(':*')) return pattern;
  if (pattern.endsWith(' *')) return `${pattern.slice(0, -2)}:*`;
  return pattern;
}

function canonicalToCopilotMcpApproval(parsed: { pattern: string }): CopilotToolApproval | null {
  const parts = parsed.pattern.split(/[.:/]/).filter(Boolean);
  if (parts.length === 0) return null;
  const [serverName, toolName] = parts;
  return { kind: 'mcp', serverName, toolName: toolName ?? null };
}

function canonicalToCopilotApproval(permission: string): CopilotToolApproval | null {
  const parsed = parseCanonicalPattern(permission);
  if (!parsed) return null;
  if (parsed.tool === 'bash') {
    const identifier = canonicalBashToCopilotCommandIdentifier(parsed.pattern);
    return identifier ? { kind: 'commands', commandIdentifiers: [identifier] } : null;
  }
  if ((parsed.tool === 'write' || parsed.tool === 'edit') && (parsed.pattern === '*' || parsed.pattern === '**')) {
    return { kind: 'write' };
  }
  if (parsed.tool === 'read' && (parsed.pattern === '*' || parsed.pattern === '**')) {
    return { kind: 'read' };
  }
  if (parsed.tool === 'mcp') {
    return canonicalToCopilotMcpApproval(parsed);
  }
  return null;
}

function mergeCopilotApprovals(existing: unknown[], incoming: CopilotToolApproval[]): CopilotToolApproval[] {
  const byKey = new Map<string, CopilotToolApproval>();
  const add = (approval: CopilotToolApproval): void => {
    if (approval.kind === 'commands') {
      const current = byKey.get('commands') as { kind: 'commands'; commandIdentifiers: string[] } | undefined;
      const commandIdentifiers = new Set([...(current?.commandIdentifiers ?? []), ...approval.commandIdentifiers]);
      byKey.set('commands', { kind: 'commands', commandIdentifiers: Array.from(commandIdentifiers).sort() });
      return;
    }
    byKey.set(JSON.stringify(approval), approval);
  };

  for (const approval of existing) {
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)) continue;
    const record = approval as Record<string, unknown>;
    if (record.kind === 'commands' && Array.isArray(record.commandIdentifiers)) {
      add({ kind: 'commands', commandIdentifiers: record.commandIdentifiers.filter((v): v is string => typeof v === 'string') });
    } else if (record.kind === 'read' || record.kind === 'write') {
      add({ kind: record.kind });
    } else if (record.kind === 'mcp' && typeof record.serverName === 'string' && (typeof record.toolName === 'string' || record.toolName === null)) {
      add({ kind: 'mcp', serverName: record.serverName, toolName: record.toolName });
    }
  }
  for (const approval of incoming) add(approval);
  return Array.from(byKey.values());
}

export function convertToCopilotFormat(set: PermissionSet, location: string): CopilotPermissionsConfig {
  const approvals: CopilotToolApproval[] = [];
  for (const permission of set.allow) {
    const approval = canonicalToCopilotApproval(permission);
    if (approval) approvals.push(approval);
  }
  const allowedDirectories = (set.additionalDirectories ?? [])
    .filter((dir) => dir.trim().length > 0)
    .map((dir) => path.isAbsolute(dir) ? dir : path.resolve(location, dir));
  return {
    locations: {
      [location]: {
        ...(approvals.length > 0 ? { tool_approvals: mergeCopilotApprovals([], approvals) } : {}),
        ...(allowedDirectories.length > 0 ? { allowed_directories: Array.from(new Set(allowedDirectories)).sort() } : {}),
      },
    },
  };
}

/** Convert canonical Bash rules into Droid's command arrays. */
export function convertToDroidFormat(set: PermissionSet): {
  commandAllowlist: string[];
  commandDenylist: string[];
} {
  const commands = (permissions: string[]): string[] => {
    const result = new Set<string>();
    for (const permission of permissions) {
      if (BLANKET_BASH_FORMS.has(permission)) {
        result.add('*');
        continue;
      }
      const parsed = parseCanonicalPattern(permission);
      if (parsed?.tool === 'bash') result.add(normalizeBashPattern(parsed.pattern));
    }
    return Array.from(result);
  };

  return {
    commandAllowlist: commands(set.allow),
    commandDenylist: commands(set.deny ?? []),
  };
}

/**
 * Convert canonical permission set to OpenClaw's `tools.alsoAllow`/`tools.deny`.
 *
 * OpenClaw's allowlist is tool-level only, so ONLY blanket (whole-tool) rules
 * map — a rule is blanket iff it's a bare tool with no parens (`Bash`), it's in
 * BLANKET_BASH_FORMS, or its pattern is `*`/`**` (`Read(**)`, `Write(*)`).
 * Sub-command/path/domain rules (`Bash(git:*)`, `Write(secrets/**)`,
 * `WebFetch(domain:x)`) are SKIPPED — coarse-mapping a specific deny to a whole
 * tool would wrongly gate every use of that tool. Output arrays are deduped and
 * sorted for deterministic writes/tests.
 */
export function convertToOpenClawFormat(set: PermissionSet): { alsoAllow: string[]; deny: string[] } {
  const map = (permissions: string[]): string[] => {
    const tools = new Set<string>();
    for (const perm of permissions) {
      // Bare tool name with no parens (e.g. "Bash", "Read") is a blanket grant;
      // parseCanonicalPattern requires parens, so handle it first.
      const bare = perm.match(/^(\w+)$/);
      if (bare) {
        const id = CANONICAL_TO_OPENCLAW_TOOL[bare[1].toLowerCase()];
        if (id) tools.add(id);
        continue;
      }
      const parsed = parseCanonicalPattern(perm);
      if (!parsed) continue;
      const isBlanket = BLANKET_BASH_FORMS.has(perm) || parsed.pattern === '*' || parsed.pattern === '**';
      if (!isBlanket) continue;
      const id = CANONICAL_TO_OPENCLAW_TOOL[parsed.tool];
      if (id) tools.add(id);
    }
    return Array.from(tools).sort();
  };

  return {
    alsoAllow: map(set.allow),
    deny: map(set.deny ?? []),
  };
}

export function convertToHermesFormat(set: PermissionSet): { command_allowlist: string[]; approvals: { deny: string[] } } {
  const commands = (permissions: string[]): string[] => {
    const out = new Set<string>();
    for (const perm of permissions) {
      if (BLANKET_BASH_FORMS.has(perm)) {
        out.add('*');
        continue;
      }
      const parsed = parseCanonicalPattern(perm);
      if (parsed?.tool === 'bash') out.add(normalizeBashPattern(parsed.pattern));
    }
    return Array.from(out).sort();
  };

  return {
    command_allowlist: commands(set.allow),
    approvals: { deny: commands(set.deny ?? []) },
  };
}

/**
 * Convert canonical permission set to Antigravity format.
 * Antigravity reads ~/.gemini/antigravity-cli/settings.json with
 *   { permissions: { allow: [...], deny: [...] } }
 * where each entry is action-namespaced: command(...), read_file(...),
 * write_file(...), read_url(...), mcp(...).
 * Bash maps to `command`, Read to `read_file`, Write to `write_file`,
 * WebFetch to `read_url`. Other canonical tools are skipped.
 * Note: Antigravity matches `command(npm install)` as an exact string,
 * not a prefix — `Bash(npm:*)` becomes `command(npm *)` which is a glob
 * but Antigravity upstream has a known exact-match bug for some forms.
 */
export function convertToAntigravityFormat(set: PermissionSet): { permissions: { allow: string[]; deny?: string[] } } {
  const allow = serializeAntigravityEntries(set.allow);
  const deny = set.deny ? serializeAntigravityEntries(set.deny) : [];
  return {
    permissions: {
      allow,
      ...(deny.length ? { deny } : {}),
    },
  };
}

function serializeAntigravityEntries(perms: string[]): string[] {
  const out = new Set<string>();
  for (const perm of perms) {
    if (BLANKET_BASH_FORMS.has(perm)) {
      out.add('command(*)');
      continue;
    }
    const parsed = parseCanonicalPattern(perm);
    if (!parsed) continue;
    const action = ANTIGRAVITY_ACTION_BY_TOOL[parsed.tool];
    if (!action) continue;
    if (parsed.tool === 'bash') {
      out.add(`${action}(${normalizeBashPattern(parsed.pattern)})`);
    } else {
      const p = parsed.pattern === '**' ? '*' : parsed.pattern;
      out.add(`${action}(${p})`);
    }
  }
  return Array.from(out);
}

/**
 * Convert canonical permission set to Grok format.
 * Grok reads ~/.grok/config.toml with
 *   [permission]
 *   rules = [ { action = "allow", tool = "bash", pattern = "git *" }, ... ]
 * Tool names are lowercase: bash, read, edit, grep, mcptool, webfetch.
 * Canonical Write maps to Grok's `edit` tool.
 */
export function convertToGrokFormat(set: PermissionSet): { permission: { rules: GrokRule[] } } {
  const rules: GrokRule[] = [];
  for (const perm of set.allow) {
    const rule = canonicalToGrokRule(perm, 'allow');
    if (rule) rules.push(rule);
  }
  if (set.deny) {
    for (const perm of set.deny) {
      const rule = canonicalToGrokRule(perm, 'deny');
      if (rule) rules.push(rule);
    }
  }
  return { permission: { rules } };
}

export type GrokRule = { action: 'allow' | 'deny'; tool: string; pattern?: string };

function canonicalToGrokRule(perm: string, action: 'allow' | 'deny'): GrokRule | null {
  if (BLANKET_BASH_FORMS.has(perm)) {
    // Grok's `*` is a SINGLE-LEVEL wildcard, so a `pattern: '*'` bash rule does
    // NOT auto-approve a multi-token command like `ssh host cmd` or `scp a b`
    // (PHNX-3294 — verified: two boxes carrying the identical `pattern="*"` rule
    // differed only by `[ui].permission_mode`, and only the always-approve box
    // ran ssh without prompting). Grok's documented "bare prefix matches all
    // invocations" idiom is a rule with NO `pattern` key — the true allow-all
    // shell form, matching how kimi (bare `Bash`), droid (`*`) and claude
    // express a blanket Bash grant. This reads back as `Bash(*)` via the
    // registry's pattern-less path, so the round-trip is unchanged.
    return { action, tool: 'bash' };
  }
  const parsed = parseCanonicalPattern(perm);
  if (!parsed) return null;
  const tool = GROK_TOOL_BY_CANONICAL[parsed.tool];
  if (!tool) return null;
  const pattern = parsed.tool === 'bash' ? normalizeBashPattern(parsed.pattern) : parsed.pattern;
  if (pattern === '' || pattern === undefined) {
    return { action, tool };
  }
  return { action, tool, pattern };
}

export type KimiRule = { decision: 'allow' | 'deny'; pattern: string };

/**
 * Parse a canonical permission string preserving the tool's original casing.
 * `parseCanonicalPattern` lowercases the tool name, which is fine for Grok
 * (lowercase tool vocabulary) but wrong for Kimi, whose tool names are
 * capitalized (`Bash`, `Read`, `Grep`). Bare tool names (no parens, e.g.
 * `Read` or an MCP id like `mcp__server__tool`) return `pattern: null`.
 */
function parseCanonicalPreserveCase(perm: string): { tool: string; pattern: string | null } {
  const m = perm.match(/^([\w-]+)\((.*)\)$/);
  if (m) return { tool: m[1], pattern: m[2] };
  return { tool: perm, pattern: null };
}

/**
 * Translate a canonical Bash arg-glob (`cmd:*`) into the Kimi pattern(s) that
 * actually match that command's invocations.
 *
 * Kimi matches Bash arg-globs with picomatch, where `*` does NOT cross `/` and a
 * `**` only globstars when it is its own path segment (`*​/**`, `**​/`). A plain
 * `cmd*` therefore matches `git status -s` but NOT `git push origin feat/x` or
 * `cat dir/file` — any argument containing a slash falls through to a prompt
 * (verified interactively against kimi 0.12.1). We emit TWO patterns so the
 * command auto-approves whether its args contain a slash or not:
 *   - `cmd*`     — no-slash args (and the bare command; `*` is zero-or-more).
 *   - `cmd*​/**` — args with a path: `*` consumes up to the first `/`, then the
 *                 bounded globstar crosses the remaining slashes.
 * "git push:*" -> ["git push*", "git push*​/**"].
 */
function kimiBashPatterns(pattern: string): string[] {
  if (pattern === '*' || pattern === '**') return ['*'];
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return [`${prefix}*`, `${prefix}*/**`];
  }
  // Exact command (no `:*`, e.g. `env`, `pwd`, `true`) — no path args expected.
  return [pattern];
}

function canonicalToKimiRules(perm: string, decision: 'allow' | 'deny'): KimiRule[] {
  if (BLANKET_BASH_FORMS.has(perm)) {
    return [{ decision, pattern: 'Bash' }];
  }
  const { tool, pattern } = parseCanonicalPreserveCase(perm);
  // Bare tool name (no parens) — name-only match. Covers `Read`, `Grep`, and
  // MCP tool ids, which Kimi can only match by name anyway.
  if (pattern === null) {
    return [{ decision, pattern: tool }];
  }
  if (tool.toLowerCase() === 'bash') {
    return kimiBashPatterns(pattern).map((p) => ({
      decision,
      pattern: p === '*' ? 'Bash' : `Bash(${p})`,
    }));
  }
  // Non-Bash built-ins (Read/Write/Edit/Grep/Glob/WebFetch...) share Kimi's
  // capitalized tool vocabulary, so pass the tool+pattern through. A `**`/`*`
  // glob means "any" — collapse to a name-only rule.
  if (pattern === '*' || pattern === '**') {
    return [{ decision, pattern: tool }];
  }
  return [{ decision, pattern: `${tool}(${pattern})` }];
}

/**
 * Convert a canonical permission set to Kimi Code's `[permission].rules` format.
 * Kimi (`~/.kimi-code/config.toml`) reads rules of the form
 *   [[permission.rules]]
 *   decision = "allow"
 *   pattern  = "Bash(git status*)"
 * Tool names are capitalized and the Bash arg-glob uses a trailing `*` (no
 * Claude `:*` separator). Without this conversion the canonical strings match
 * nothing in Kimi's engine and every tool call falls through to a prompt.
 *
 * Each `:*` Bash rule expands to TWO patterns (`cmd*` and `cmd*​/**`) so the
 * command auto-approves whether or not its arguments contain a slash — see
 * `kimiBashPatterns` for why Kimi's picomatch matcher needs both.
 */
export function convertToKimiFormat(set: PermissionSet): { permission: { rules: KimiRule[] } } {
  const rules: KimiRule[] = [];
  for (const perm of set.allow) {
    rules.push(...canonicalToKimiRules(perm, 'allow'));
  }
  if (set.deny) {
    for (const perm of set.deny) {
      rules.push(...canonicalToKimiRules(perm, 'deny'));
    }
  }
  return { permission: { rules } };
}

/**
 * Convert canonical permission set to OpenCode format.
 * OpenCode uses: { permission: { bash: { "git *": "allow", "rm *": "deny" } } }
 */
export function convertToOpenCodeFormat(set: PermissionSet): OpenCodePermissions {
  const bashPermissions: Record<string, 'allow' | 'deny' | 'ask'> = {};

  // Process allow list
  for (const perm of set.allow) {
    if (BLANKET_BASH_FORMS.has(perm)) {
      // Bare "Bash" has no parens so parseCanonicalPattern returns null;
      // normalize all three blanket forms to "*".
      bashPermissions['*'] = 'allow';
      continue;
    }
    const parsed = parseCanonicalPattern(perm);
    if (parsed && parsed.tool === 'bash') {
      bashPermissions[parsed.pattern] = 'allow';
    }
  }

  // Process deny list
  if (set.deny) {
    for (const perm of set.deny) {
      const parsed = parseCanonicalPattern(perm);
      if (parsed && parsed.tool === 'bash') {
        bashPermissions[parsed.pattern] = 'deny';
      }
    }
  }

  return {
    permission: {
      bash: bashPermissions,
    },
  };
}

/**
 * Default extra writable roots for Codex's `workspace-write` sandbox: the
 * regenerable package/toolchain caches that build/test/install write OUTSIDE the
 * workspace (cargo registry, npm/bun/pnpm caches, GOPATH/GOCACHE, the OS cache
 * root, …). Without these, a sandboxed `cargo build` / `go build` / `npm install`
 * fails on its cache write, which is what pushes users to `--mode full` (YOLO).
 *
 * Credential dirs (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.netrc`) are
 * deliberately EXCLUDED so the sandbox stays meaningful — this is far from
 * danger-full-access. Resolved per platform + home; each box regenerates its own
 * Codex config on sync, so the paths always match the box Codex runs on.
 */
export function codexDefaultWritableRoots(
  home: string = HOME,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const shared = ['.cargo', '.rustup', '.npm', '.bun', 'go', '.deno', '.gradle', '.m2', '.gem'];
  const roots = shared.map((d) => path.join(home, d));
  if (platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Caches'), path.join(home, 'Library', 'pnpm'));
  } else {
    // Linux/XDG: ~/.cache covers pip, uv, go-build, ms-playwright, etc.
    roots.push(path.join(home, '.cache'), path.join(home, '.local', 'share'), path.join(home, '.local', 'state'));
  }
  return roots;
}

/**
 * Merge Codex `[sandbox_workspace_write]` config, UNIONing `writable_roots` so a
 * baseline cache root never clobbers a root the user configured directly (a
 * plain object spread would overwrite the whole array), while merging scalar
 * keys (`network_access`) normally. Shared by the user- and version-scoped Codex
 * config writers so the two can't drift.
 */
export function mergeCodexSandboxWrite(
  existing: Record<string, unknown> | undefined,
  incoming: NonNullable<CodexPermissions['sandbox_workspace_write']>,
): Record<string, unknown> {
  const existingRoots = Array.isArray(existing?.writable_roots)
    ? (existing!.writable_roots as string[])
    : [];
  const unionRoots = [...new Set([...existingRoots, ...(incoming.writable_roots ?? [])])];
  return {
    ...existing,
    ...incoming,
    ...(unionRoots.length > 0 ? { writable_roots: unionRoots } : {}),
  };
}

/**
 * Convert canonical permission set to Codex format.
 * Codex uses coarse-grained modes, so we infer the best fit.
 */
export function convertToCodexFormat(set: PermissionSet, cwd?: string): CodexPermissions {
  const result: CodexPermissions = {};

  // Check for broad bash permissions -> suggest full-auto.
  // Treat the bare blanket form "Bash" the same as "Bash(*)" / "Bash(**)";
  // parseCanonicalPattern requires parens so "Bash" alone wouldn't match
  // otherwise — the difference determines whether a pod runs unattended
  // (approval_policy: 'never') or stalls on interactive approvals.
  const hasBroadBash = set.allow.some((p) => {
    if (BLANKET_BASH_FORMS.has(p)) return true;
    const parsed = parseCanonicalPattern(p);
    return parsed !== null && parsed.tool === 'bash' && (parsed.pattern === '*' || parsed.pattern === '**');
  });

  if (hasBroadBash) {
    result.approval_policy = 'never';
    result.sandbox_mode = 'workspace-write';
  } else if (set.allow.length > 0) {
    result.approval_policy = 'on-request';
    result.sandbox_mode = 'workspace-write';
  }

  // Check for network/web permissions
  const hasNetwork = set.allow.some((p) => {
    const parsed = parseCanonicalPattern(p);
    return parsed && (parsed.tool === 'websearch' || parsed.tool === 'webfetch');
  });

  if (hasNetwork) {
    result.sandbox_workspace_write = {
      network_access: true,
    };
  }

  // Baseline (unconditional): always grant the regenerable build/test/install
  // caches as writable roots so `agents run codex` in workspace-write can build,
  // test, and install without escalating to danger-full-access. Merged with
  // network_access above when set; applyCodexPermissions unions these with any
  // writable_roots the user configured directly.
  result.sandbox_workspace_write = {
    ...result.sandbox_workspace_write,
    writable_roots: codexDefaultWritableRoots(),
  };

  return result;
}

// ============================================================================
// Read agent permissions from native configs
// ============================================================================


/**
 * Read Claude's current permissions from settings.json.
 */
function readClaudePermissions(
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  options?: { home?: string }
): ClaudePermissions | null {
  const home = options?.home || HOME;
  const configPath = scope === 'user'
    ? path.join(home, '.claude', 'settings.json')
    : path.join(cwd || process.cwd(), '.claude', 'settings.json');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    if (config.permissions) {
      return {
        permissions: {
          allow: config.permissions.allow || [],
          deny: config.permissions.deny || [],
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read OpenCode's current permissions from opencode.jsonc.
 */
function readOpenCodePermissions(
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  options?: { home?: string }
): OpenCodePermissions | null {
  const home = options?.home || HOME;
  const configPath = openCodeConfigPath(scope, cwd, home);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
    const config = JSON.parse(content);
    if (config.permission) {
      return {
        permission: {
          bash: config.permission.bash || {},
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read Codex's current permissions from config.toml.
 */
function readCodexPermissions(
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  options?: { home?: string }
): CodexPermissions | null {
  const home = options?.home || HOME;
  const configPath = scope === 'user'
    ? path.join(home, '.codex', 'config.toml')
    : path.join(cwd || process.cwd(), '.codex', 'config.toml');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = TOML.parse(content) as Record<string, unknown>;

    const result: CodexPermissions = {};

    if (config.approval_policy) {
      result.approval_policy = config.approval_policy as CodexPermissions['approval_policy'];
    }
    if (config.sandbox_mode) {
      result.sandbox_mode = config.sandbox_mode as CodexPermissions['sandbox_mode'];
    }
    if (config.sandbox_workspace_write) {
      const sw = config.sandbox_workspace_write as Record<string, unknown>;
      result.sandbox_workspace_write = {
        network_access: sw.network_access as boolean | undefined,
        writable_roots: sw.writable_roots as string[] | undefined,
      };
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Read an agent's currently installed permissions.
 *
 * claude/opencode/codex return their NATIVE shape, because `agents permissions
 * list` renders those three specially — Codex especially, whose config records a
 * sandbox mode rather than a rule list, so its own fields say more than the
 * blanket grants that mode widens into.
 *
 * Every other allowlist-capable harness returns the canonical `PermissionSet`
 * that `PERMISSION_TARGETS` reads back. Before RUSH-2676 they returned `null`,
 * so permissions written for cursor, antigravity, grok, kimi, droid,
 * copilot, openclaw and hermes were reported as absent.
 */
export function readAgentPermissions(
  agentId: AgentId,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  options?: { home?: string }
): ClaudePermissions | OpenCodePermissions | CodexPermissions | PermissionSet | null {
  switch (agentId) {
    case 'claude':
      return readClaudePermissions(scope, cwd, options);
    case 'opencode':
      return readOpenCodePermissions(scope, cwd, options);
    case 'codex':
      return readCodexPermissions(scope, cwd, options);
    default:
      return readCanonicalPermissions(agentId, scope, cwd, options?.home);
  }
}

// ============================================================================
// Apply permissions to agents
// ============================================================================

/**
 * Apply a permission set to Claude's settings.json.
 */
export function applyClaudePermissions(
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  const configDir = scope === 'user'
    ? path.join(HOME, '.claude')
    : path.join(cwd || process.cwd(), '.claude');
  const configPath = path.join(configDir, 'settings.json');

  try {
    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Read existing config
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    const newPermissions = convertToClaudeFormat(set);

    if (merge && config.permissions) {
      const existing = config.permissions as { allow?: string[]; deny?: string[] };
      // Rewrite stale Write(path) rules already installed in settings.json too.
      const mergedAllow = new Set([...(existing.allow || []).map(canonicalToClaudeRule), ...newPermissions.permissions.allow]);
      const mergedDeny = new Set([...(existing.deny || []).map(canonicalToClaudeRule), ...newPermissions.permissions.deny]);
      config.permissions = {
        allow: [...mergedAllow],
        deny: [...mergedDeny],
      };
    } else {
      config.permissions = newPermissions.permissions;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Path OpenCode actually loads for global config:
 *   ~/.config/opencode/opencode.jsonc  (or .json)
 * Project: <cwd>/opencode.jsonc (or .json) at project root — not .opencode/.
 * See https://opencode.ai/docs/config/
 */
export function openCodeConfigPath(scope: 'user' | 'project', cwd?: string, home: string = HOME): string {
  if (scope === 'project') {
    const root = cwd || process.cwd();
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(root, 'opencode.jsonc');
  }
  const globalDir = path.join(home, '.config', 'opencode');
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const candidate = path.join(globalDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(globalDir, 'opencode.jsonc');
}

/**
 * Apply a permission set to OpenCode's opencode.jsonc.
 */
function applyOpenCodePermissions(
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  const configPath = openCodeConfigPath(scope, cwd);
  const configDir = path.dirname(configPath);

  try {
    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Read existing config
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
      config = JSON.parse(content);
    }

    const newPermissions = convertToOpenCodeFormat(set);

    if (merge && config.permission) {
      const existing = config.permission as { bash?: Record<string, string> };
      config.permission = {
        ...existing,
        bash: {
          ...(existing.bash || {}),
          ...newPermissions.permission.bash,
        },
      };
    } else {
      config.permission = newPermissions.permission;
    }

    // Write without comments (they'll be lost)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Apply a permission set to Codex's config.toml.
 */
function applyCodexPermissions(
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  const configDir = scope === 'user'
    ? path.join(HOME, '.codex')
    : path.join(cwd || process.cwd(), '.codex');
  const configPath = path.join(configDir, 'config.toml');

  try {
    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Read existing config
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = TOML.parse(content) as Record<string, unknown>;
    }

    const newPermissions = convertToCodexFormat(set, cwd);

    // Merge or replace
    if (newPermissions.approval_policy) {
      config.approval_policy = newPermissions.approval_policy;
    }
    if (newPermissions.sandbox_mode) {
      config.sandbox_mode = newPermissions.sandbox_mode;
    }
    if (newPermissions.sandbox_workspace_write) {
      const existing = config.sandbox_workspace_write as Record<string, unknown> | undefined;
      // merge=false is a deliberate full replace (drops any user-custom roots);
      // production sync always passes merge=true, taking the union path.
      config.sandbox_workspace_write = merge
        ? mergeCodexSandboxWrite(existing, newPermissions.sandbox_workspace_write)
        : newPermissions.sandbox_workspace_write;
    }

    fs.writeFileSync(configPath, TOML.stringify(config as any), 'utf-8');

    syncCodexDenyRules(configDir, set.deny);

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Apply a permission set to an agent (global config).
 */
function applyPermissionsToAgent(
  agentId: AgentId,
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  switch (agentId) {
    case 'claude':
      return applyClaudePermissions(set, scope, cwd, merge);
    case 'opencode':
      return applyOpenCodePermissions(set, scope, cwd, merge);
    case 'codex':
      return applyCodexPermissions(set, scope, cwd, merge);
    default:
      return { success: false, error: `Agent '${agentId}' does not support permissions` };
  }
}

/**
 * Apply a permission set to a specific version's home directory.
 * This writes to {versionHome}/.{agent}/settings.json (or equivalent).
 */
export function applyPermissionsToVersion(
  agentId: AgentId,
  set: PermissionSet,
  versionHome: string,
  merge: boolean = true,
  cwd?: string
): { success: boolean; error?: string } {
  if (!supports(agentId, 'allowlist').ok) {
    return { success: false, error: `Agent '${agentId}' does not support permissions` };
  }

  const configDir = path.join(versionHome, agentConfigDirName(agentId));

  try {
    fs.mkdirSync(configDir, { recursive: true });

    if (agentId === 'claude') {
      const configPath = path.join(configDir, 'settings.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      const newPermissions = convertToClaudeFormat(set);

      if (merge && config.permissions) {
        const existing = config.permissions as { allow?: string[]; deny?: string[]; additionalDirectories?: string[] };
        // Rewrite stale Write(path) rules already installed in settings.json too.
        const mergedAllow = new Set([...(existing.allow || []).map(canonicalToClaudeRule), ...newPermissions.permissions.allow]);
        const mergedDeny = new Set([...(existing.deny || []).map(canonicalToClaudeRule), ...newPermissions.permissions.deny]);
        const mergedDirs = new Set([...(existing.additionalDirectories || []), ...(newPermissions.permissions.additionalDirectories || [])]);
        const perms: Record<string, unknown> = {
          allow: [...mergedAllow],
          deny: [...mergedDeny],
        };
        if (mergedDirs.size > 0) {
          perms.additionalDirectories = [...mergedDirs];
        }
        config.permissions = perms;
      } else {
        config.permissions = newPermissions.permissions;
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'opencode') {
      // OpenCode loads ~/.config/opencode/opencode.jsonc under the version home
      // (HOME isolation), not ~/.opencode/opencode.jsonc.
      const configPath = openCodeConfigPath('user', undefined, versionHome);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
        config = JSON.parse(content);
      }

      const newPermissions = convertToOpenCodeFormat(set);

      if (merge && config.permission) {
        const existing = config.permission as { bash?: Record<string, string> };
        config.permission = {
          ...existing,
          bash: {
            ...(existing.bash || {}),
            ...newPermissions.permission.bash,
          },
        };
      } else {
        config.permission = newPermissions.permission;
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'codex') {
      const configPath = path.join(configDir, 'config.toml');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        config = TOML.parse(content) as Record<string, unknown>;
      }

      const newPermissions = convertToCodexFormat(set);

      if (newPermissions.approval_policy) {
        config.approval_policy = newPermissions.approval_policy;
      }
      if (newPermissions.sandbox_mode) {
        config.sandbox_mode = newPermissions.sandbox_mode;
      }
      if (newPermissions.sandbox_workspace_write) {
        const existing = config.sandbox_workspace_write as Record<string, unknown> | undefined;
        // merge=false is a deliberate full replace (drops any user-custom roots);
        // production sync always passes merge=true, taking the union path.
        config.sandbox_workspace_write = merge
          ? mergeCodexSandboxWrite(existing, newPermissions.sandbox_workspace_write)
          : newPermissions.sandbox_workspace_write;
      }

      fs.writeFileSync(configPath, TOML.stringify(config as any), 'utf-8');

      syncCodexDenyRules(configDir, set.deny);

      return { success: true };
    }

    if (agentId === 'antigravity') {
      const antigravityPerms = convertToAntigravityFormat(set);
      const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');
      updateGeminiSettings(settingsPath, (settings) => {
        const perms = (typeof settings.permissions === 'object' && settings.permissions !== null && !Array.isArray(settings.permissions))
          ? settings.permissions as Record<string, unknown>
          : {};
        if (merge) {
          const existingAllow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
          const existingDeny = Array.isArray(perms.deny) ? (perms.deny as string[]) : [];
          perms.allow = Array.from(new Set([...existingAllow, ...antigravityPerms.permissions.allow]));
          const mergedDeny = Array.from(new Set([...existingDeny, ...(antigravityPerms.permissions.deny ?? [])]));
          if (mergedDeny.length) perms.deny = mergedDeny;
          else delete perms.deny;
        } else {
          perms.allow = antigravityPerms.permissions.allow;
          if (antigravityPerms.permissions.deny?.length) perms.deny = antigravityPerms.permissions.deny;
          else delete perms.deny;
        }
        settings.permissions = perms;
      });
      return { success: true };
    }

    if (agentId === 'grok') {
      const grokPerms = convertToGrokFormat(set);
      const configPath = path.join(versionHome, '.grok', 'config.toml');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
      const existingPermission = (typeof config.permission === 'object' && config.permission !== null && !Array.isArray(config.permission))
        ? config.permission as Record<string, unknown>
        : {};
      if (merge) {
        const existingRules = Array.isArray(existingPermission.rules) ? (existingPermission.rules as GrokRule[]) : [];
        const seen = new Set<string>();
        const dedup: GrokRule[] = [];
        for (const r of [...existingRules, ...grokPerms.permission.rules]) {
          const key = `${r.action}|${r.tool}|${r.pattern ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dedup.push(r);
        }
        existingPermission.rules = dedup;
      } else {
        existingPermission.rules = grokPerms.permission.rules;
      }
      config.permission = existingPermission;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, TOML.stringify(config as any), 'utf-8');
      return { success: true };
    }

    if (agentId === 'kimi') {
      const configPath = path.join(versionHome, '.kimi-code', 'config.toml');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }

      const newRules: Array<{ decision: string; pattern: string }> = convertToKimiFormat(set).permission.rules;

      if (merge) {
        const existingPermission = (typeof config.permission === 'object' && config.permission !== null && !Array.isArray(config.permission))
          ? config.permission as Record<string, unknown>
          : {};
        const existingRules = Array.isArray(existingPermission.rules)
          ? (existingPermission.rules as Array<{ decision?: string; pattern?: string }>)
          : [];
        const seen = new Set<string>();
        const dedup: Array<{ decision: string; pattern: string }> = [];
        for (const r of [...existingRules, ...newRules]) {
          if (!r.decision || !r.pattern) continue;
          const key = `${r.decision}|${r.pattern}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dedup.push({ decision: r.decision, pattern: r.pattern });
        }
        config.permission = { rules: dedup };
      } else {
        config.permission = { rules: newRules };
      }

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, TOML.stringify(config as any), 'utf-8');
      return { success: true };
    }

    if (agentId === 'cursor') {
      // Cursor CLI permissions live in ~/.cursor/cli-config.json
      const configPath = path.join(configDir, 'cli-config.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        } catch { /* start fresh */ }
      }
      const converted = convertToCursorFormat(set);
      if (merge && config.permissions && typeof config.permissions === 'object') {
        const existing = config.permissions as { allow?: string[]; deny?: string[] };
        const allow = new Set([...(existing.allow || []), ...converted.permissions.allow]);
        const deny = new Set([...(existing.deny || []), ...converted.permissions.deny]);
        config.permissions = { allow: [...allow], deny: [...deny] };
      } else {
        config.permissions = converted.permissions;
      }
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'droid') {
      const configPath = path.join(versionHome, '.factory', 'settings.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
      const converted = convertToDroidFormat(set);
      if (merge) {
        const existingAllow = Array.isArray(config.commandAllowlist) ? config.commandAllowlist as string[] : [];
        const existingDeny = Array.isArray(config.commandDenylist) ? config.commandDenylist as string[] : [];
        config.commandAllowlist = Array.from(new Set([...existingAllow, ...converted.commandAllowlist]));
        config.commandDenylist = Array.from(new Set([...existingDeny, ...converted.commandDenylist]));
      } else {
        config.commandAllowlist = converted.commandAllowlist;
        config.commandDenylist = converted.commandDenylist;
      }
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'copilot') {
      const configPath = path.join(versionHome, '.copilot', 'permissions-config.json');
      let config: CopilotPermissionsConfig = { locations: {} };
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as CopilotPermissionsConfig;
      }

      const location = path.resolve(cwd ?? process.cwd());
      const converted = convertToCopilotFormat(set, location);
      const incoming = converted.locations[location]?.tool_approvals ?? [];
      const incomingDirectories = converted.locations[location]?.allowed_directories ?? [];
      if (merge && incoming.length === 0 && incomingDirectories.length === 0) return { success: true };

      const locations = (typeof config.locations === 'object' && config.locations !== null && !Array.isArray(config.locations))
        ? config.locations
        : {};
      const existingLocation = (typeof locations[location] === 'object' && locations[location] !== null && !Array.isArray(locations[location]))
        ? locations[location]
        : {};
      const existingApprovals = Array.isArray(existingLocation.tool_approvals) ? existingLocation.tool_approvals : [];
      const nextApprovals = merge ? mergeCopilotApprovals(existingApprovals, incoming) : incoming;
      const existingDirectories = Array.isArray(existingLocation.allowed_directories)
        ? existingLocation.allowed_directories.filter((v): v is string => typeof v === 'string')
        : [];
      const nextDirectories = merge
        ? Array.from(new Set([...existingDirectories, ...incomingDirectories])).sort()
        : incomingDirectories;
      const nextLocation = { ...existingLocation };
      if (nextApprovals.length > 0) nextLocation.tool_approvals = nextApprovals;
      else delete nextLocation.tool_approvals;
      if (nextDirectories.length > 0) nextLocation.allowed_directories = nextDirectories;
      else delete nextLocation.allowed_directories;

      if (Object.keys(nextLocation).length > 0) locations[location] = nextLocation;
      else delete locations[location];
      config.locations = locations;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'openclaw') {
      // OpenClaw's allowlist lives in ~/.openclaw/openclaw.json under `tools`.
      // Only blanket tool-level rules map (see convertToOpenClawFormat). We
      // read-modify-write to preserve all other keys (mcp, exec, agents, …) and
      // never touch `tools.allow` (the absolute allowlist that replaces defaults).
      const configPath = path.join(versionHome, '.openclaw', 'openclaw.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
      const converted = convertToOpenClawFormat(set);

      const existingTools = (typeof config.tools === 'object' && config.tools !== null && !Array.isArray(config.tools))
        ? config.tools as Record<string, unknown>
        : {};
      let alsoAllow: string[];
      let deny: string[];
      if (merge) {
        const existingAllow = Array.isArray(existingTools.alsoAllow) ? existingTools.alsoAllow as string[] : [];
        const existingDeny = Array.isArray(existingTools.deny) ? existingTools.deny as string[] : [];
        alsoAllow = Array.from(new Set([...existingAllow, ...converted.alsoAllow]));
        deny = Array.from(new Set([...existingDeny, ...converted.deny]));
      } else {
        alsoAllow = converted.alsoAllow;
        deny = converted.deny;
      }

      // Set or delete each key: avoid writing empty arrays (churn). On a
      // non-merge replace with nothing to write, delete the stale key.
      const tools: Record<string, unknown> = { ...existingTools };
      if (alsoAllow.length > 0) tools.alsoAllow = alsoAllow;
      else delete tools.alsoAllow;
      if (deny.length > 0) tools.deny = deny;
      else delete tools.deny;

      if (Object.keys(tools).length > 0) config.tools = tools;
      else delete config.tools;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'hermes') {
      const configPath = path.join(versionHome, '.hermes', 'config.yaml');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        }
      }

      const converted = convertToHermesFormat(set);
      const approvals = (typeof config.approvals === 'object' && config.approvals !== null && !Array.isArray(config.approvals))
        ? config.approvals as Record<string, unknown>
        : {};

      if (merge) {
        const existingAllow = Array.isArray(config.command_allowlist) ? config.command_allowlist as string[] : [];
        const existingDeny = Array.isArray(approvals.deny) ? approvals.deny as string[] : [];
        config.command_allowlist = Array.from(new Set([...existingAllow, ...converted.command_allowlist])).sort();
        approvals.deny = Array.from(new Set([...existingDeny, ...converted.approvals.deny])).sort();
      } else {
        config.command_allowlist = converted.command_allowlist;
        approvals.deny = converted.approvals.deny;
      }

      config.approvals = approvals;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
      return { success: true };
    }

    return { success: false, error: `Agent '${agentId}' does not support permissions` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Export canonical format from agent
// ============================================================================

/**
 * Convert Claude permissions back to canonical format.
 */
export function claudeToCanonical(perms: ClaudePermissions): PermissionSet {
  const result: PermissionSet = {
    name: 'exported',
    allow: perms.permissions.allow,
    deny: perms.permissions.deny.length > 0 ? perms.permissions.deny : undefined,
  };
  if (perms.permissions.additionalDirectories?.length) {
    result.additionalDirectories = perms.permissions.additionalDirectories;
  }
  return result;
}

/**
 * Convert OpenCode permissions back to canonical format.
 */
export function openCodeToCanonical(perms: OpenCodePermissions): PermissionSet {
  const allow: string[] = [];
  const deny: string[] = [];

  for (const [pattern, action] of Object.entries(perms.permission.bash)) {
    if (action === 'allow') {
      allow.push(`Bash(${pattern})`);
    } else if (action === 'deny') {
      deny.push(`Bash(${pattern})`);
    }
  }

  return {
    name: 'exported',
    allow,
    deny: deny.length > 0 ? deny : undefined,
  };
}

/**
 * Convert Codex permissions back to canonical format (approximation).
 */
export function codexToCanonical(perms: CodexPermissions): PermissionSet {
  const allow: string[] = [];

  if (perms.approval_policy === 'never' || perms.sandbox_mode === 'danger-full-access') {
    allow.push('Bash(*)');
    allow.push('Read(**)');
    allow.push('Write(**)');
    allow.push('Edit(**)');
  } else if (perms.sandbox_mode === 'workspace-write') {
    allow.push('Bash(*)');
    allow.push('Read(**)');
  }

  if (perms.sandbox_workspace_write?.network_access) {
    allow.push('WebSearch(*)');
    allow.push('WebFetch(*)');
  }

  return {
    name: 'exported',
    allow,
  };
}

/**
 * Export permissions from a specific config file path to canonical format,
 * auto-detecting the harness from the path.
 *
 * Detection walks `PERMISSION_TARGETS` and matches each harness's own declared
 * filename + parent directory, so it covers all 13 rather than the three
 * hardcoded `.claude`/`.opencode`/`.codex` fragments it used to know about.
 */
export function exportPermissionsFromPath(filePath: string): PermissionSet | null {
  if (!fs.existsSync(filePath)) return null;

  const agentId = detectPermissionAgentFromPath(filePath);
  if (!agentId) return null;

  return PERMISSION_TARGETS[agentId]!.toCanonical(filePath);
}

/**
 * Which harness owns `filePath`, by comparing against the trailing path segments
 * each registry target declares. Longer (more specific) suffixes win, so
  */
export function detectPermissionAgentFromPath(filePath: string): AgentId | null {
  const normalized = path.resolve(filePath).split(path.sep).join('/');
  let best: { agentId: AgentId; length: number } | null = null;

  for (const [agent, target] of Object.entries(PERMISSION_TARGETS)) {
    const agentId = agent as AgentId;
    // `altSuffixes` first: home()/project() may probe the filesystem to choose
    // between accepted spellings, and with an empty root that probe resolves
    // against process.cwd() -- so detection must not depend on it.
    const candidates = [
      ...(target!.altSuffixes ?? []),
      target!.home(''),
      ...(target!.project ? [target!.project('')] : []),
    ];
    for (const candidate of candidates) {
      const suffix = candidate.split(path.sep).join('/').replace(/^\/+/, '');
      if (!suffix) continue;
      if (normalized === suffix || normalized.endsWith(`/${suffix}`)) {
        if (!best || suffix.length > best.length) best = { agentId, length: suffix.length };
      }
    }
  }

  return best?.agentId ?? null;
}

/**
 * Save a permission set to central storage.
 */
function savePermissionSet(set: PermissionSet): { success: boolean; error?: string } {
  ensurePermissionsDir();
  const filePath = safeJoin(path.join(getUserPermissionsDir(), 'groups'), set.name + '.yml');

  try {
    const content = yaml.stringify({
      name: set.name,
      description: set.description,
      allow: set.allow,
      deny: set.deny,
    });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Name used for the default permission set in central storage. */
const DEFAULT_PERMISSION_SET_NAME = 'default';

/**
 * Get the default permission set from central storage.
 */
export function getDefaultPermissionSet(): PermissionSet {
  const existing = getPermissionSet(DEFAULT_PERMISSION_SET_NAME);
  if (existing) {
    return existing.set;
  }
  return {
    name: DEFAULT_PERMISSION_SET_NAME,
    description: 'Default permission set',
    allow: [],
    deny: [],
  };
}

/**
 * Compute diff between existing and new permissions.
 * Returns { added, existing, removed } for both allow and deny rules.
 */
export function computePermissionsDiff(
  existing: PermissionSet,
  incoming: PermissionSet
): {
  allow: { added: string[]; existing: string[] };
  deny: { added: string[]; existing: string[] };
} {
  const existingAllowSet = new Set(existing.allow);
  const existingDenySet = new Set(existing.deny || []);

  const allowAdded = incoming.allow.filter((r) => !existingAllowSet.has(r));
  const allowExisting = incoming.allow.filter((r) => existingAllowSet.has(r));

  const incomingDeny = incoming.deny || [];
  const denyAdded = incomingDeny.filter((r) => !existingDenySet.has(r));
  const denyExisting = incomingDeny.filter((r) => existingDenySet.has(r));

  return {
    allow: { added: allowAdded, existing: allowExisting },
    deny: { added: denyAdded, existing: denyExisting },
  };
}

/**
 * Merge incoming permissions into existing, deduplicating.
 */
export function mergePermissionSets(existing: PermissionSet, incoming: PermissionSet): PermissionSet {
  const allowSet = new Set([...existing.allow, ...incoming.allow]);
  const denySet = new Set([...(existing.deny || []), ...(incoming.deny || [])]);
  const dirsSet = new Set([...(existing.additionalDirectories || []), ...(incoming.additionalDirectories || [])]);

  const result: PermissionSet = {
    name: existing.name,
    description: existing.description,
    allow: Array.from(allowSet).sort(),
    deny: Array.from(denySet).sort(),
  };
  if (dirsSet.size > 0) {
    result.additionalDirectories = Array.from(dirsSet).sort();
  }
  return result;
}

/**
 * Save the default permission set.
 */
export function saveDefaultPermissionSet(set: PermissionSet): { success: boolean; error?: string } {
  set.name = DEFAULT_PERMISSION_SET_NAME;
  return savePermissionSet(set);
}

// ============================================================================
// Content-drift check (agents doctor, PHNX-3504)
// ============================================================================

/**
 * Harnesses whose native permission file carries a per-rule allow/deny list the
 * writer emits verbatim, so `agents doctor` can verify a group's rules survived
 * into the version home rule-for-rule. The compare is done in the harness's OWN
 * native vocabulary (Cursor `Shell(...)`, Droid command arrays, …) — NOT
 * canonical — because every target's canonical round-trip is lossy
 * (`lossyBecause` in `permissions-registry.ts`), so a canonical subset check
 * would false-diff a correctly-synced home.
 *
 * Every other allowlist harness (codex/grok/kimi/antigravity/hermes/copilot)
 * stores a lossy projection — a sandbox flag, whole-tool gate, per-directory
 * approval, or a split/merged pattern — with no faithful per-group provenance, so
 * doctor stays presence-only there and says so (`detail: 'format cannot verify
 * content'`) rather than faking `ok`.
 */
export const PERMISSIONS_REPRESENTABLE: ReadonlySet<AgentId> = new Set<AgentId>([
  'claude',
  'opencode',
  'cursor',
  'droid',
  'openclaw',
]);

interface NativeRuleSets {
  allow: Set<string>;
  deny: Set<string>;
}

function toStringSet(v: unknown): Set<string> {
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

function readJsonFileSafe(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** allow/deny rule strings in `agent`'s NATIVE vocabulary from its version home. */
function homeNativePermissionRules(agent: AgentId, versionHome: string): NativeRuleSets | null {
  const target = PERMISSION_TARGETS[agent];
  if (!target) return null;
  const configPath = target.home(versionHome);
  if (!fs.existsSync(configPath)) return null;
  switch (agent) {
    case 'claude':
    case 'cursor': {
      const c = readJsonFileSafe(configPath);
      const perms = (c?.permissions ?? {}) as Record<string, unknown>;
      return { allow: toStringSet(perms.allow), deny: toStringSet(perms.deny) };
    }
    case 'droid': {
      const c = readJsonFileSafe(configPath);
      return { allow: toStringSet(c?.commandAllowlist), deny: toStringSet(c?.commandDenylist) };
    }
    case 'openclaw': {
      const c = readJsonFileSafe(configPath);
      const tools = (c?.tools ?? {}) as Record<string, unknown>;
      return { allow: toStringSet(tools.alsoAllow), deny: toStringSet(tools.deny) };
    }
    case 'opencode': {
      let c: Record<string, unknown> | null = null;
      try {
        c = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf-8'))) as Record<string, unknown>;
      } catch { return null; }
      const bash = ((c?.permission as Record<string, unknown> | undefined)?.bash ?? {}) as Record<string, unknown>;
      const allow = new Set<string>();
      const deny = new Set<string>();
      for (const [pattern, action] of Object.entries(bash)) {
        if (action === 'allow') allow.add(pattern);
        else if (action === 'deny') deny.add(pattern);
      }
      return { allow, deny };
    }
    default:
      return null;
  }
}

/** allow/deny rule strings in `agent`'s NATIVE vocabulary the writer WOULD emit. */
function expectedNativePermissionRules(agent: AgentId, set: PermissionSet): NativeRuleSets {
  switch (agent) {
    case 'claude': {
      const c = convertToClaudeFormat(set);
      return { allow: new Set(c.permissions.allow), deny: new Set(c.permissions.deny) };
    }
    case 'cursor': {
      const c = convertToCursorFormat(set);
      return { allow: new Set(c.permissions.allow), deny: new Set(c.permissions.deny ?? []) };
    }
    case 'droid': {
      const c = convertToDroidFormat(set);
      return { allow: new Set(c.commandAllowlist), deny: new Set(c.commandDenylist) };
    }
    case 'openclaw': {
      const c = convertToOpenClawFormat(set);
      return { allow: new Set(c.alsoAllow), deny: new Set(c.deny) };
    }
    case 'opencode': {
      const c = convertToOpenCodeFormat(set);
      const allow = new Set<string>();
      const deny = new Set<string>();
      for (const [pattern, action] of Object.entries(c.permission.bash)) {
        if (action === 'allow') allow.add(pattern);
        else if (action === 'deny') deny.add(pattern);
      }
      return { allow, deny };
    }
    default:
      return { allow: new Set(), deny: new Set() };
  }
}

/**
 * True when permission GROUP `groupName` is faithfully present in `agent`'s
 * version home — every rule the group renders into that harness's native format
 * is on disk. Only meaningful for {@link PERMISSIONS_REPRESENTABLE} agents (the
 * caller keeps the lossy harnesses presence-only); returns true for a lossy
 * harness or an empty/header group so the caller does not down-rank it.
 *
 * The expected rules are re-derived from the CURRENT source group every call
 * (never a stored hash), so a rule edited/added in the source group surfaces as
 * drift even though the group name is unchanged (PHNX-3504).
 */
export function permissionsGroupMatches(
  agent: AgentId,
  versionHome: string,
  groupName: string,
): boolean {
  if (!PERMISSIONS_REPRESENTABLE.has(agent)) return true;
  const expected = expectedNativePermissionRules(agent, buildPermissionsFromGroups([groupName]));
  if (expected.allow.size === 0 && expected.deny.size === 0) return true; // header / empty group
  const home = homeNativePermissionRules(agent, versionHome);
  if (!home) return false;
  for (const r of expected.allow) if (!home.allow.has(r)) return false;
  for (const r of expected.deny) if (!home.deny.has(r)) return false;
  return true;
}
