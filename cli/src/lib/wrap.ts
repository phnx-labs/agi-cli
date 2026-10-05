/**
 * Terminal word-wrap — one shared helper for the whole CLI.
 *
 * Multi-line word wrapping is the gap the single-line helpers in
 * `session/width.ts` (`truncateToWidth`, `padToWidth`) do not fill. Anywhere that
 * renders variable-length text into a fixed-width terminal wraps through THIS,
 * never a per-field slice.
 *
 * Width is measured with `stringWidth` (from the canonical `session/width.ts`),
 * NOT `String.length`: the text this wraps is routinely ANSI-coloured (chalk /
 * marked-terminal output) and may carry OSC-8 hyperlinks, where `.length`
 * over-counts the invisible escape bytes. Words are split on whitespace, so a
 * wrap boundary always falls between escape sequences, never inside one.
 */

import { stringWidth } from './session/width.js';

/**
 * Hard-wrap `text` to `cols` visible columns.
 *
 * - Splits on existing newlines first (each paragraph wraps independently).
 * - Wraps on whitespace; a single word wider than the available width is emitted
 *   on its own line rather than split mid-word (and never mid-escape).
 * - Width is the visible display width via `stringWidth`, so ANSI colour and
 *   OSC-8 hyperlink escapes do not inflate the count.
 * - `hangingIndent` pads every line AFTER the first with that many spaces, so a
 *   labelled value ("Latest  <text>") keeps its continuation lines aligned under
 *   the value. The wrapping width is `cols - indent`.
 * - Floor: when `hangingIndent` is set, the width is floored at 8 so a
 *   pathologically large indent still makes forward progress. With no indent the
 *   floor is 1, so a legitimately small `cols` is respected, never overridden. A
 *   non-finite `cols` degrades to the floor rather than silently disabling wrap.
 *
 * Returns the wrapped lines (never mutates input). An empty string yields [''].
 */
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
