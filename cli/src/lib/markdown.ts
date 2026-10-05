/** Terminal-aware Markdown rendering (marked + marked-terminal) into ANSI text. */
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// @ts-expect-error - marked-terminal types don't match marked's MarkedExtension
marked.use(markedTerminal());

/**
 * Render markdown content for terminal display.
 */
export function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}
