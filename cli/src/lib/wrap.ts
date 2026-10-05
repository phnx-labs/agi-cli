/** Shared terminal word-wrap helper: anywhere rendering variable-length text into a fixed width
 * wraps through this. Width uses `stringWidth`, not `.length`, since text is often ANSI-coloured
 * or has OSC-8 links; wraps fall between words, never inside an escape. */

import { stringWidth } from './session/width.js';

/** Hard-wrap `text` to `cols` visible columns: paragraphs wrap independently, an over-wide word
 * gets its own line, `hangingIndent` pads later lines (width `cols - indent`, floored at 8 with an
 * indent, else 1). Never mutates input; empty gives ['']. */
export function wrapToWidth(text: string, cols: number, hangingIndent = 0): string[] {
  const indent = Math.max(0, Math.trunc(hangingIndent));
  const floor = indent > 0 ? 8 : 1;
  const width = Number.isFinite(cols) ? Math.max(floor, cols - indent) : floor;
  const pad = ' '.repeat(indent);
  const out: string[] = [];

  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    for (const word of words) {
      const wordWidth = stringWidth(word);
      if (line === '') {
        line = word;
        lineWidth = wordWidth;
      } else if (lineWidth + 1 + wordWidth > width) {
        out.push(line);
        line = word;
        lineWidth = wordWidth;
      } else {
        line = `${line} ${word}`;
        lineWidth += 1 + wordWidth;
      }
    }
    if (line !== '') out.push(line);
  }
  if (out.length === 0) out.push('');
  return out.map((l, i) => (i === 0 ? l : pad + l));
}
