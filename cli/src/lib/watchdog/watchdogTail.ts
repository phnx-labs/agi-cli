// Watchdog tail summarization: pull the most recent user / assistant message
// out of the session JSONL window the watchdog read this tick. Pure functions —
// the watchdog runtime hands us tailLines + agentType and we read no files.
// Ported from Swarmify (extension/src/core/watchdogTail.ts) — behavior verbatim.

interface TailSummary {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}

const MAX_MESSAGE_CHARS = 600;

export function summarizeWatchdogTail(
  tailLines: string[],
  agentType: string | undefined,
): TailSummary {
  let lastUser: string | undefined;
  let lastAssistant: string | undefined;

  for (let i = tailLines.length - 1; i >= 0; i--) {
    if (lastUser && lastAssistant) break;
    let raw: unknown;
    try {
      raw = JSON.parse(tailLines[i]);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;

    if (agentType === 'claude') {
      const claim = readClaude(raw as Record<string, unknown>);
      if (claim?.role === 'user' && !lastUser) lastUser = claim.text;
      else if (claim?.role === 'assistant' && !lastAssistant) lastAssistant = claim.text;
    } else if (agentType === 'codex') {
      const claim = readCodex(raw as Record<string, unknown>);
      if (claim?.role === 'user' && !lastUser) lastUser = claim.text;
      else if (claim?.role === 'assistant' && !lastAssistant) lastAssistant = claim.text;
    } else if (agentType === 'gemini') {
      const claim = readGemini(raw as Record<string, unknown>);
      if (claim?.role === 'user' && !lastUser) lastUser = claim.text;
      else if (claim?.role === 'assistant' && !lastAssistant) lastAssistant = claim.text;
    }
  }

  return {
    lastUserMessage: clip(lastUser),
    lastAssistantMessage: clip(lastAssistant),
  };
}

type Claim = { role: 'user' | 'assistant'; text: string };

function readClaude(raw: Record<string, unknown>): Claim | null {
  const t = raw.type;
  if (t !== 'user' && t !== 'assistant') return null;
  const msg = raw.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const text = pickContentText(msg.content);
  if (!text) return null;
  return { role: t, text };
}

function readCodex(raw: Record<string, unknown>): Claim | null {
  if (raw.type !== 'response_item') return null;
  const payload = raw.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'message') return null;
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const text = pickContentText(payload.content);
  if (!text) return null;
  return { role, text };
}

// Gemini stores chats as a single pretty-printed JSON document — readTailLines
// returns partial fragments that JSON.parse rejects. So in practice this
// branch only fires for the JSONL-style events that some Gemini wrappers emit
// during a live session. Acceptable: the result is an empty summary, which
// the UI handles gracefully.
function readGemini(raw: Record<string, unknown>): Claim | null {
  const t = raw.type;
  if (t === 'user_message') {
    const text = typeof raw.text === 'string' ? raw.text : null;
    return text ? { role: 'user', text } : null;
  }
  if (t === 'agent_message' || t === 'model_message') {
    const text = typeof raw.text === 'string' ? raw.text : null;
    return text ? { role: 'assistant', text } : null;
  }
  if (t === 'message') {
    const role = raw.role === 'user' ? 'user' : raw.role === 'assistant' ? 'assistant' : null;
    if (!role) return null;
    const text = typeof raw.text === 'string' ? raw.text : pickContentText(raw.content);
    return text ? { role, text } : null;
  }
  return null;
}

function pickContentText(content: unknown): string | null {
  if (typeof content === 'string') return isSyntheticTagged(content) ? null : content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if ((p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') {
      if (isSyntheticTagged(p.text)) continue;
      parts.push(p.text);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

// Mirrors the synthetic-tag filter in the session readers so a "User: …"
// surfaced in the watchdog UI never shows a <local-command-stdout>,
// <system-reminder>, or similar harness chunk that Claude wraps tool output in.
const SYNTHETIC_TAG_PREFIXES = [
  '<local-command-caveat',
  '<local-command-stdout',
  '<local-command-stderr',
  '<command-name',
  '<command-message',
  '<command-args',
  '<bash-input',
  '<bash-stdout',
  '<bash-stderr',
  '<system-reminder',
  '<user-prompt-submit-hook',
  '<task-notification',
  '<persisted-output',
];

function isSyntheticTagged(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  for (const prefix of SYNTHETIC_TAG_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_MESSAGE_CHARS
    ? cleaned.slice(0, MAX_MESSAGE_CHARS - 1) + '…'
    : cleaned;
}
