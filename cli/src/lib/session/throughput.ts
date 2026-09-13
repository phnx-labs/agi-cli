/**
 * Live output-token throughput.
 *
 * Computes a rolling tokens-per-second readout from a session transcript's raw
 * content. This is the single source of truth for the throughput number the
 * Fleet shows next to a running agent — the extension used to carry its
 * own copy of this math (`computeOutputTokensPerSec`); it now reads `tokPerSec`
 * straight off `agents sessions --active --json` instead (issue #741).
 */

/** Agents whose transcript formats report per-turn output-token usage. */
type ThroughputAgent = 'claude' | 'codex' | 'gemini';

/** Rolling window (seconds) the throughput average is computed over. */
const DEFAULT_THROUGHPUT_WINDOW_SEC = 60;

/**
 * Output-token throughput (tokens/sec) over the last `windowSec` seconds.
 *
 * Sums output tokens (plus reasoning/thoughts tokens when the format reports
 * them separately) from entries whose timestamp falls within the window, and
 * divides by the window length.
 *
 * Formats:
 *   - Claude: JSONL. Each assistant turn is `{type: 'assistant', timestamp,
 *     message: {usage: {output_tokens}}}`.
 *   - Codex:  JSONL. Each token_count event is `{type: 'event_msg', timestamp,
 *     payload: {type: 'token_count', info: {last_token_usage: {output_tokens,
 *     reasoning_output_tokens}}}}`. `last_token_usage` is per-turn (not cumulative).
 *   - Gemini: single JSON object. `{messages: [{type: 'gemini', timestamp,
 *     tokens: {output, thoughts}}]}`. Caller must pass the whole file.
 */
export function computeTokPerSec(
  sessionContent: string,
  agent: ThroughputAgent,
  windowSec: number = DEFAULT_THROUGHPUT_WINDOW_SEC,
  now: number = Date.now(),
): number {
  const cutoff = now - windowSec * 1000;
  let total = 0;
  if (agent === 'gemini') {
    try {
      const d = JSON.parse(sessionContent);
      const messages = Array.isArray(d?.messages) ? d.messages : [];
      for (const m of messages) {
        if (m?.type !== 'gemini') continue;
        const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : 0;
        if (!ts || ts < cutoff) continue;
        const out = typeof m?.tokens?.output === 'number' ? m.tokens.output : 0;
        const thoughts = typeof m?.tokens?.thoughts === 'number' ? m.tokens.thoughts : 0;
        total += out + thoughts;
      }
    } catch { /* malformed gemini file → 0 */ }
    return total / windowSec;
  }
  const lines = sessionContent.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    if (!line.includes('output_tokens')) continue;
    try {
      const d = JSON.parse(line);
      const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : 0;
      if (!ts) continue;
      if (ts < cutoff) break;
      if (agent === 'claude') {
        if (d?.type !== 'assistant') continue;
        const out = typeof d?.message?.usage?.output_tokens === 'number' ? d.message.usage.output_tokens : 0;
        total += out;
      } else {
        if (d?.type !== 'event_msg') continue;
        const payload = d?.payload;
        if (payload?.type !== 'token_count') continue;
        const last = payload?.info?.last_token_usage;
        if (!last) continue;
        const out = typeof last.output_tokens === 'number' ? last.output_tokens : 0;
        const reasoning = typeof last.reasoning_output_tokens === 'number' ? last.reasoning_output_tokens : 0;
        total += out + reasoning;
      }
    } catch { /* skip malformed line */ }
  }
  return total / windowSec;
}
