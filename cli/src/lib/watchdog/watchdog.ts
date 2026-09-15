// Watchdog: pure logic for detecting stalled agent terminals and rendering the
// prompt that the watchdog AGENT reads to decide idle-vs-unfinished and craft a
// nudge. There is deliberately no heuristic decider here (no regex over the tail
// guessing "done" vs "stuck") — that judgment is the agent's job. This module
// only classifies idleness by timestamp and renders/parses the agent's I/O, so
// it reads no files and touches no host APIs and can be unit-tested in isolation.

export interface WatchdogCandidate {
  terminalId: string;
  agentType: 'claude' | 'codex';
  tailLines: string[];
  stalledForMs: number;
  /** The originating task / first prompt / topic — so the agent can judge "was given a task but hasn't finished it". */
  task?: string;
  /** Working directory of the session, for context. */
  cwd?: string;
}

export interface Decision {
  terminalId: string;
  action: 'nudge' | 'skip';
  text: string;
  reason: string;
  /**
   * Set by the agent on a SKIP to distinguish "genuinely needs the human"
   * (true → surface it) from "the task is actually done" (false/absent → leave
   * it alone, do not poke). `done` is a distinct terminal state from `idle`.
   */
  needsHuman?: boolean;
}

export type StallStatus =
  | { kind: 'active' }
  | { kind: 'dormant' }
  | { kind: 'opted_out' }
  | { kind: 'rate_limited'; cooldownRemainingMs: number }
  | { kind: 'stalled'; stalledForMs: number };

interface ClassifyInput {
  lastActivityMs: number;
  nowMs: number;
  lastNudgeMs: number | null;
  optedOut: boolean;
  stallMs: number;
  cooldownMs: number;
  dormantMs: number;
}

export function classifyTerminal(input: ClassifyInput): StallStatus {
  if (input.optedOut) return { kind: 'opted_out' };
  const age = input.nowMs - input.lastActivityMs;
  if (age < input.stallMs) return { kind: 'active' };
  if (age > input.dormantMs) return { kind: 'dormant' };
  if (input.lastNudgeMs !== null) {
    const sinceNudge = input.nowMs - input.lastNudgeMs;
    if (sinceNudge < input.cooldownMs) {
      return { kind: 'rate_limited', cooldownRemainingMs: input.cooldownMs - sinceNudge };
    }
  }
  return { kind: 'stalled', stalledForMs: age };
}

export const WATCHDOG_SYSTEM_PROMPT = `You are the watchdog for AI coding agents running in terminals. You are given the idle
sessions on this machine — each with its originating TASK, how long it has been idle, and
the tail of its transcript. Your one job is to tell, for each one, whether it is
IDLE-BUT-UNFINISHED (it was given a task, went quiet, and has NOT finished or handed it
off) or IDLE-AND-DONE (it finished, or it genuinely needs the human). Idle-but-unfinished
is the dangerous state — the work is most likely to be silently abandoned — so those get a
NUDGE that drives them to finish. Everything else is a SKIP.

Read each transcript before judging — an agent that already reached a decision needs "do
it," not "decide." Judge from the task + tail, not from keywords.

NUDGE when the agent went idle and could keep going on its own:
- It asked permission for an obvious or already-authorized next step
  ("should I proceed?", "want me to continue?", "shall I run the tests?").
- It asked a question it could answer itself from the available context or a
  reasonable default, or by using a tool it already has.
- It announced an action ("I'll run X", "let me write Y") but no tool call followed.
- It already decided what to do, then stalled without doing it.
- It paused with the task incomplete and no real blocker.

The nudge text MUST carry context, not shove:
- Restate the goal and reference the conclusion the agent ALREADY reached.
- Give ONE concrete next step — the specific action, the sensible default, or a TOOL it
  forgot it has (e.g. "agents computer" to drive the Mac, "agents browser" for the web,
  "agents ssh <mac> \\"agents computer …\\"" to drive a Mac from another box).
- Split the ask: drive the reversible, goal-advancing part now; flag only a genuinely
  disruptive sub-step for the human.
- Tell it to use best judgment and finish end-to-end WITHOUT asking again.
- Imperative, 1-2 sentences, no emojis, under 240 characters.

SKIP in two distinct cases — mark which with "needsHuman":
- needsHuman=true — the agent is genuinely blocked on a human (these belong in the user's
  feed): credentials, auth, login, 2FA, or biometric; an irreversible or outward-facing
  action needing sign-off (force-push, delete prod data, publish/release, spend money,
  send an external message) UNLESS the House Rules below authorize it; a real product or
  intent decision with genuine ambiguity (not a trivial default); or you cannot tell what
  the agent is doing.
- needsHuman=false — the task is actually complete (idle-and-done). Leave it alone; do NOT
  poke a finished session.

Respond with ONLY a JSON array (no prose, no code fence). Include "needsHuman" on every
skip:
[{"terminalId":"<id>","action":"nudge"|"skip","text":"<message or empty>","reason":"<brief>","needsHuman":true|false}]`;

// User-editable playbook appended below the built-in prompt. The user maintains
// the source at ~/.agents/playbooks/watchdog.md (read by the delivery layer);
// this function is pure so it can be tested without filesystem access.
export function composePromptWithPlaybook(basePrompt: string, playbook: string): string {
  const trimmed = playbook.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\n## House Rules (user playbook)\n\n${trimmed}`;
}

export function renderWatchdogPrompt(candidates: WatchdogCandidate[], playbook = ''): string {
  const systemPrompt = composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, playbook);
  const parts: string[] = [systemPrompt, '', 'IDLE SESSIONS:', ''];
  for (const c of candidates) {
    const seconds = Math.round(c.stalledForMs / 1000);
    parts.push(`--- terminal ${c.terminalId} (${c.agentType}, idle ${seconds}s) ---`);
    if (c.task) parts.push(`task: ${c.task}`);
    if (c.cwd) parts.push(`cwd: ${c.cwd}`);
    parts.push('last JSONL lines:');
    for (const line of c.tailLines) {
      parts.push(line);
    }
    parts.push('');
  }
  return parts.join('\n');
}

export function parseWatchdogResponse(stdout: string): Decision[] {
  if (!stdout || !stdout.trim()) return [];

  const arrayMatch = stdout.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const decisions: Decision[] = [];
  for (const d of parsed) {
    if (!d || typeof d !== 'object') continue;
    const obj = d as Record<string, unknown>;
    const terminalId = typeof obj.terminalId === 'string' ? obj.terminalId : '';
    const action = obj.action === 'nudge' || obj.action === 'skip' ? obj.action : null;
    const text = typeof obj.text === 'string' ? obj.text : '';
    const reason = typeof obj.reason === 'string' ? obj.reason : '';
    if (!terminalId || !action) continue;
    // needsHuman only meaningful on a skip; a nudge is never "needs human".
    const needsHuman = action === 'skip' && obj.needsHuman === true ? true
      : action === 'skip' && obj.needsHuman === false ? false
      : undefined;
    decisions.push({ terminalId, action, text, reason, needsHuman });
  }
  return decisions;
}
