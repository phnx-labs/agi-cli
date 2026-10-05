import { describe, it, expect } from 'vitest';
import {
  classifyTerminal,
  composePromptWithPlaybook,
  renderWatchdogPrompt,
  parseWatchdogResponse,
  WATCHDOG_SYSTEM_PROMPT,
} from './watchdog.js';

describe('classifyTerminal', () => {
  const base = {
    nowMs: 1_000_000,
    lastNudgeMs: null,
    optedOut: false,
    stallMs: 90_000,
    cooldownMs: 300_000,
    dormantMs: 3_600_000,
  };

  it('active when within stall window', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 10_000 });
    expect(r.kind).toBe('active');
  });

  it('opted_out when user disabled watchdog for terminal', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 120_000,
      optedOut: true,
    });
    expect(r.kind).toBe('opted_out');
  });

  it('dormant when session is older than dormant window', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 3_600_001 });
    expect(r.kind).toBe('dormant');
  });

  it('rate_limited when recently nudged', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 120_000,
      lastNudgeMs: base.nowMs - 60_000,
    });
    expect(r.kind).toBe('rate_limited');
    if (r.kind === 'rate_limited') {
      expect(r.cooldownRemainingMs).toBe(240_000);
    }
  });

  it('stalled when past threshold, not dormant, not rate limited, not opted out', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 120_000 });
    expect(r.kind).toBe('stalled');
    if (r.kind === 'stalled') {
      expect(r.stalledForMs).toBe(120_000);
    }
  });

  it('opt-out wins over active', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 10_000,
      optedOut: true,
    });
    expect(r.kind).toBe('opted_out');
  });

  it('cooldown expired lets terminal go back to stalled', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 400_000,
      lastNudgeMs: base.nowMs - 310_000,
    });
    expect(r.kind).toBe('stalled');
  });

  it('active takes priority even when a nudge is on cooldown (boundary just under stall)', () => {
    const r = classifyTerminal({
      ...base,
      lastActivityMs: base.nowMs - 89_999,
      lastNudgeMs: base.nowMs - 1_000,
    });
    expect(r.kind).toBe('active');
  });

  it('exactly at the stall threshold is not yet active (age === stallMs)', () => {
    const r = classifyTerminal({ ...base, lastActivityMs: base.nowMs - 90_000 });
    expect(r.kind).toBe('stalled');
  });
});

describe('composePromptWithPlaybook', () => {
  it('returns the base prompt unchanged when playbook is empty', () => {
    expect(composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, '')).toBe(WATCHDOG_SYSTEM_PROMPT);
  });

  it('returns the base prompt unchanged when playbook is only whitespace', () => {
    expect(composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, '   \n\n   ')).toBe(WATCHDOG_SYSTEM_PROMPT);
  });

  it('appends a House Rules section with the trimmed playbook content', () => {
    const playbook = '\n\n- Nudge with TEST_MARKER when lint hangs.\n- Skip in plan mode.\n\n';
    const out = composePromptWithPlaybook(WATCHDOG_SYSTEM_PROMPT, playbook);
    expect(out.startsWith(WATCHDOG_SYSTEM_PROMPT + '\n\n## House Rules')).toBe(true);
    expect(out).toContain('TEST_MARKER');
    expect(out).toContain('Skip in plan mode');
    expect(out.endsWith('\n')).toBe(false);
  });
});

describe('renderWatchdogPrompt', () => {
  it('matches base prompt when no playbook is passed (zero regression)', () => {
    const out = renderWatchdogPrompt([
      { terminalId: 'CC-1', agentType: 'claude', tailLines: ['{}'], stalledForMs: 60_000 },
    ]);
    expect(out).toContain(WATCHDOG_SYSTEM_PROMPT);
    expect(out).not.toContain('## House Rules');
  });

  it('appends House Rules block when a non-empty playbook is passed', () => {
    const out = renderWatchdogPrompt(
      [{ terminalId: 'CC-1', agentType: 'claude', tailLines: ['{}'], stalledForMs: 60_000 }],
      '- Nudge with TEST_MARKER when stuck on lint.'
    );
    expect(out).toContain('## House Rules');
    expect(out).toContain('TEST_MARKER');
    const houseIdx = out.indexOf('## House Rules');
    const idleIdx = out.indexOf('IDLE SESSIONS:');
    expect(houseIdx).toBeGreaterThan(-1);
    expect(idleIdx).toBeGreaterThan(houseIdx);
  });

  it('includes the originating task and cwd so the agent can judge unfinished-vs-done', () => {
    const out = renderWatchdogPrompt([
      { terminalId: 'CC-1', agentType: 'claude', tailLines: ['{}'], stalledForMs: 60_000, task: 'port the watchdog', cwd: '/repo/agents-cli' },
    ]);
    expect(out).toContain('task: port the watchdog');
    expect(out).toContain('cwd: /repo/agents-cli');
  });

  it('embeds terminal id, agent type, stall duration, and JSONL tail', () => {
    const out = renderWatchdogPrompt([
      {
        terminalId: 'CC-1',
        agentType: 'claude',
        tailLines: [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"I\'ll write inventory.sh."}]}}',
        ],
        stalledForMs: 120_000,
      },
    ]);
    expect(out).toContain('CC-1');
    expect(out).toContain('claude');
    expect(out).toContain('idle 120s');
    expect(out).toContain("I'll write inventory.sh");
    expect(out).toContain('JSON array');
  });

  it('separates multiple terminals into labeled sections', () => {
    const out = renderWatchdogPrompt([
      { terminalId: 'CC-1', agentType: 'claude', tailLines: ['{"a":1}'], stalledForMs: 100_000 },
      { terminalId: 'CX-2', agentType: 'codex', tailLines: ['{"b":2}'], stalledForMs: 200_000 },
    ]);
    expect(out).toContain('terminal CC-1');
    expect(out).toContain('terminal CX-2');
    expect(out).toContain('idle 100s');
    expect(out).toContain('idle 200s');
  });
});

describe('parseWatchdogResponse', () => {
  it('parses a clean JSON array', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"CC-1","action":"nudge","text":"Show the file.","reason":"broken_promise"}]'
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toEqual({
      terminalId: 'CC-1',
      action: 'nudge',
      text: 'Show the file.',
      reason: 'broken_promise',
    });
  });

  it('tolerates leading and trailing prose', () => {
    const d = parseWatchdogResponse(
      'Here is the response:\n[{"terminalId":"CC-1","action":"skip","text":"","reason":"waiting_on_user"}]\nThanks.'
    );
    expect(d).toHaveLength(1);
    expect(d[0].action).toBe('skip');
  });

  it('returns empty on malformed JSON', () => {
    expect(parseWatchdogResponse('not json at all')).toEqual([]);
    expect(parseWatchdogResponse('[{invalid]')).toEqual([]);
  });

  it('skips entries missing required fields', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"CC-1","action":"nudge","text":"ok","reason":"r"},{"action":"nudge"},{"terminalId":"CX-2"}]'
    );
    expect(d).toHaveLength(1);
    expect(d[0].terminalId).toBe('CC-1');
  });

  it('rejects unknown action values', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"CC-1","action":"explode","text":"","reason":""}]'
    );
    expect(d).toEqual([]);
  });

  it('handles empty input', () => {
    expect(parseWatchdogResponse('')).toEqual([]);
    expect(parseWatchdogResponse('   \n ')).toEqual([]);
  });

  it('extracts the array even when wrapped in a markdown code fence', () => {
    const d = parseWatchdogResponse(
      '```json\n[{"terminalId":"CC-1","action":"nudge","text":"Run tests.","reason":"stalled"}]\n```'
    );
    expect(d).toHaveLength(1);
    expect(d[0].text).toBe('Run tests.');
  });

  it('parses needsHuman on a skip (true = surface it, false = idle-and-done)', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"A","action":"skip","text":"","reason":"needs creds","needsHuman":true},' +
      '{"terminalId":"B","action":"skip","text":"","reason":"done","needsHuman":false}]'
    );
    expect(d).toHaveLength(2);
    expect(d[0].needsHuman).toBe(true);
    expect(d[1].needsHuman).toBe(false);
  });

  it('never carries needsHuman on a nudge', () => {
    const d = parseWatchdogResponse(
      '[{"terminalId":"A","action":"nudge","text":"go","reason":"unfinished","needsHuman":true}]'
    );
    expect(d[0].action).toBe('nudge');
    expect(d[0].needsHuman).toBeUndefined();
  });
});

describe('WATCHDOG_SYSTEM_PROMPT — idle-vs-unfinished judgment', () => {
  it('instructs NUDGE on needless questions and SKIP on genuine human-only cases', () => {
    const p = WATCHDOG_SYSTEM_PROMPT;
    expect(p).toMatch(/NUDGE/);
    expect(p).toMatch(/best judgment/i);
    expect(p).toMatch(/should I proceed/i);
    expect(p).toMatch(/end-to-end/i);
    expect(p).toMatch(/SKIP/);
    expect(p).toMatch(/credentials|2fa|biometric/i);
    expect(p).toMatch(/publish\/release|force-push|irreversible/i);
    expect(p).toContain('"action":"nudge"|"skip"');
  });

  it('encodes the idle-to-completion strategy: read-first, context, split, point-at-tool', () => {
    const p = WATCHDOG_SYSTEM_PROMPT;
    expect(p).toMatch(/idle/i);
    expect(p).toMatch(/read (each|the) transcript/i);
    expect(p).toMatch(/already reached|already decided/i);
    expect(p).toMatch(/restate the goal/i);
    expect(p).toMatch(/concrete next step/i);
    expect(p).toMatch(/agents computer/);
    expect(p).toMatch(/agents browser/);
    expect(p).toMatch(/split the ask/i);
  });
});
