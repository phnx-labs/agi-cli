
interface MarkdownFrontmatter {
  description?: string;
  [key: string]: unknown;
}

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
