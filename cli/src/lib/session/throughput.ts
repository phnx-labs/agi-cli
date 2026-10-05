
type ThroughputAgent = 'claude' | 'codex';

const DEFAULT_THROUGHPUT_WINDOW_SEC = 60;

export function computeTokPerSec(
  sessionContent: string,
  agent: ThroughputAgent,
  windowSec: number = DEFAULT_THROUGHPUT_WINDOW_SEC,
  now: number = Date.now(),
): number {
  const cutoff = now - windowSec * 1000;
  let total = 0;
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
    } catch {  }
  }
  return total / windowSec;
}
