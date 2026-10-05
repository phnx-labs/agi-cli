import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// @ts-expect-error - marked-terminal types don't match marked's MarkedExtension
marked.use(markedTerminal());

export function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}
