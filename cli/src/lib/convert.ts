/**
 * Format conversion between Markdown (Claude/Codex) and TOML (Gemini) command files.
 *
 * Handles frontmatter parsing and bidirectional translation so that slash commands
 * authored in one format can be synced to agents that expect the other.
 */

/** Parsed YAML frontmatter from a Markdown command file. */
interface MarkdownFrontmatter {
  description?: string;
  [key: string]: unknown;
}

/** Extract YAML frontmatter and body from a Markdown string. Returns empty frontmatter if none found. */
function parseMarkdownFrontmatter(content: string): {
  frontmatter: MarkdownFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterRaw = match[1];
  const body = match[2];

  const frontmatter: MarkdownFrontmatter = {};
  for (const line of frontmatterRaw.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/** Convert a Markdown command file to Gemini's TOML format, translating $ARGUMENTS to {{args}}. */
export function markdownToToml(skillName: string, markdown: string): string {
  const { frontmatter, body } = parseMarkdownFrontmatter(markdown);
  const description = frontmatter.description || `Run ${skillName} command`;

  const promptContent = body
    .trim()
    .replace(/\$ARGUMENTS/g, '{{args}}');

  const lines = [
    `name = "${skillName}"`,
    `description = "${description.replace(/"/g, '\\"')}"`,
    "prompt = '''",
    promptContent,
    "'''",
    '',
  ];

  return lines.join('\n');
}

/**
 * Convert a Markdown command file to a Goose recipe YAML object.
 *
 * Goose has no native slash-command file format — a slash command is a recipe
 * (registered in `config.yaml` under `slash_commands`). The recipe schema matches
 * the one agents-cli already emits for Goose workflow/subagent recipes:
 * `version`, `title`, `description`, `instructions`, `prompt`. The Markdown body
 * (with `$ARGUMENTS` preserved) becomes both `instructions` and `prompt`.
 * Returns a plain object so the caller can `yaml.stringify` it.
 */
export function markdownToGooseRecipe(commandName: string, markdown: string): Record<string, unknown> {
  const { frontmatter, body } = parseMarkdownFrontmatter(markdown);
  const description = frontmatter.description || `Run ${commandName} command`;
  const prompt = body.trim() || description;
  return {
    version: '1.0.0',
    title: commandName,
    description,
    instructions: prompt,
    prompt,
  };
}
