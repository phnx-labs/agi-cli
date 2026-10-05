/** Goose slash-command install/remove/list/compare. Goose has no native command format: a
 * command is a recipe YAML registered under `slash_commands` in `~/.config/goose/config.yaml`.
 * Recipes go in `.config/goose/commands/`, not `recipes/`, so they are never read as workflows. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { safeJoin } from './paths.js';
import { markdownToGooseRecipe } from './convert.js';

/** Directory holding Goose slash-command recipe YAML files in a version home. */
export function gooseCommandsDir(versionHome: string): string {
  return path.join(versionHome, '.config', 'goose', 'commands');
}

/** Path to the Goose config.yaml (holds the `slash_commands` registry) in a version home. */
export function gooseCommandConfigPath(versionHome: string): string {
  return path.join(versionHome, '.config', 'goose', 'config.yaml');
}

interface SlashCommandEntry {
  command: string;
  recipe_path: string;
}

/** Reads the goose config.yaml as a mutable object. Throws, rather than returning `{}`, when a
 * non-empty file fails to parse or is not a mapping, so the whole-file rewrite never clobbers a
 * real user config. A missing or empty file returns `{}`. */
function readGooseConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf-8');
  if (raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to rewrite goose config at ${configPath}: existing file is not valid YAML ` +
      `(${(err as Error).message}). Fix or remove it, then re-sync.`
    );
  }
  if (parsed === null || parsed === undefined) return {}; // comments/whitespace only
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Refusing to rewrite goose config at ${configPath}: expected a YAML mapping but found ` +
      `${Array.isArray(parsed) ? 'a list' : typeof parsed}.`
    );
  }
  return parsed as Record<string, unknown>;
}

function readSlashCommands(config: Record<string, unknown>): SlashCommandEntry[] {
  const raw = config.slash_commands;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is SlashCommandEntry =>
      !!e && typeof e === 'object' && typeof (e as SlashCommandEntry).command === 'string'
  );
}

/** Registers or updates a `slash_commands` entry for `commandName` pointing at `recipePath`,
 * preserving every other key and entry. Idempotent. */
function registerSlashCommand(configPath: string, commandName: string, recipePath: string): void {
  const config = readGooseConfig(configPath);
  const entries = readSlashCommands(config);
  const existing = entries.find((e) => e.command === commandName);
  if (existing && existing.recipe_path === recipePath) return; // already current — no rewrite

  const next = entries.filter((e) => e.command !== commandName);
  next.push({ command: commandName, recipe_path: recipePath });
  next.sort((a, b) => a.command.localeCompare(b.command));
  config.slash_commands = next;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
}

/** Remove the `slash_commands` entry for `commandName`, preserving all other config. */
function unregisterSlashCommand(configPath: string, commandName: string): void {
  if (!fs.existsSync(configPath)) return;
  const config = readGooseConfig(configPath);
  const entries = readSlashCommands(config);
  if (!entries.some((e) => e.command === commandName)) return; // nothing to do

  const next = entries.filter((e) => e.command !== commandName);
  if (next.length > 0) {
    config.slash_commands = next;
  } else {
    delete config.slash_commands;
  }
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
}

/** Serialize a Goose command recipe from a central Markdown command file. */
function buildGooseCommandRecipe(commandName: string, sourcePath: string): string {
  const markdown = fs.readFileSync(sourcePath, 'utf-8');
  return yaml.stringify(markdownToGooseRecipe(commandName, markdown));
}

/** Installs a command into a Goose version home: writes its recipe YAML and registers the
 * `slash_commands` entry in config.yaml. */
export function installGooseCommandToVersion(
  versionHome: string,
  commandName: string,
  sourcePath: string
): { success: boolean; error?: string } {
  try {
    const dir = gooseCommandsDir(versionHome);
    fs.mkdirSync(dir, { recursive: true });
    const recipePath = safeJoin(dir, `${commandName}.yaml`);
    fs.writeFileSync(recipePath, buildGooseCommandRecipe(commandName, sourcePath), 'utf-8');
    registerSlashCommand(gooseCommandConfigPath(versionHome), commandName, recipePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** List Goose command names (recipe files) installed in a version home. */
export function listGooseCommandsInVersion(versionHome: string): string[] {
  const dir = gooseCommandsDir(versionHome);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

/** Whether an installed Goose command recipe matches the central Markdown source. */
export function gooseCommandMatches(versionHome: string, commandName: string, sourcePath: string): boolean {
  const recipePath = safeJoin(gooseCommandsDir(versionHome), `${commandName}.yaml`);
  if (!fs.existsSync(recipePath) || !fs.existsSync(sourcePath)) return false;
  try {
    // The slash_commands entry must also be registered for the command to be live.
    // (An unparseable config.yaml surfaces here as "not a match" → a re-sync, which
    // fails loudly rather than clobbering, instead of a crash during a read-only diff.)
    const registered = readSlashCommands(readGooseConfig(gooseCommandConfigPath(versionHome)))
      .some((e) => e.command === commandName);
    if (!registered) return false;

    const installed = fs.readFileSync(recipePath, 'utf-8').trim();
    const expected = buildGooseCommandRecipe(commandName, sourcePath).trim();
    return installed === expected;
  } catch {
    return false;
  }
}

/** Removes a Goose command from a version home: soft-deletes the recipe to `trashDir` (when
 * given) and unregisters its `slash_commands` entry. */
export function removeGooseCommandFromVersion(
  versionHome: string,
  commandName: string,
  trashDir?: string
): { success: boolean; error?: string } {
  try {
    const recipePath = safeJoin(gooseCommandsDir(versionHome), `${commandName}.yaml`);
    if (fs.existsSync(recipePath)) {
      if (trashDir) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(recipePath, path.join(trashDir, `${commandName}.yaml.${stamp}`));
      } else {
        fs.unlinkSync(recipePath);
      }
    }
    unregisterSlashCommand(gooseCommandConfigPath(versionHome), commandName);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
