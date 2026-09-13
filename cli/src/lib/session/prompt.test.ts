import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSessionTopic, cleanSessionPrompt, classifyUserPrompt, cleanGeneratedSessionLabel, cleanFirstUserMessage, firstUserMessageFromEvents, isSyntheticUserMessage, lastUserMessageFromEvents, tidyRequest, unwrapUserQuery, HEADLESS_PLAN_MODE_PREFIX } from './prompt.js';
import type { SessionEvent } from './types.js';

/**
 * Real turns lifted verbatim out of two live transcripts (2026-09-06), home
 * paths and the account email redacted. These are the exact shapes that made
 * the sidebar unusable: a `/model` echo that became a session's title, a skill
 * body that became a topic, and a request buried under a clip reference, ten
 * lines of pasted dispatch banner and an `@dir` mention.
 */
const REQUESTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'requests');
const fixture = (name: string): string => fs.readFileSync(path.join(REQUESTS_DIR, `${name}.txt`), 'utf8');

describe('classifyUserPrompt (a "You" line that drops path noise)', () => {
  it('folds a standalone screenshot path (with spaces) to [image]', () => {
    const r = classifyUserPrompt('/Users/muqsit/Screenshots/CleanShot 2026-08-20 at 10.11.12.png');
    expect(r).toEqual({ clean: '[image]', kind: 'image' });
  });

  it('folds an image-only turn (attachment, no real text) to [image]', () => {
    const r = classifyUserPrompt('', { hasImageAttachment: true });
    expect(r).toEqual({ clean: '[image]', kind: 'image' });
  });

  it('keeps a pasted command, first command only, prefixed with $', () => {
    const r = classifyUserPrompt('$ crabbox status\n$ crabbox list');
    expect(r).toEqual({ clean: '$ crabbox status', kind: 'command' });
  });

  it('collapses a skill install path to /<name> — only the injected system line', () => {
    const r = classifyUserPrompt('Base directory for this skill: /home/u/.claude/skills/blog\n\nWrite a post');
    expect(r).toEqual({ clean: '/blog', kind: 'skill' });
  });

  it('does NOT treat an ordinary prose mention of a skills/ path as a skill invocation', () => {
    const r = classifyUserPrompt('review the docs under ~/.agents/skills/blog and check the CHANGELOG');
    expect(r.kind).toBe('text');
    expect(r.clean).toContain('review the docs');
  });

  it('does NOT treat a markdown blockquote as a command', () => {
    const r = classifyUserPrompt('> quoting the article: agents are the future — thoughts?');
    expect(r.kind).toBe('text');
    expect(r.clean).not.toMatch(/^\$/);
  });

  it('strips wrapper tags from plain text', () => {
    const r = classifyUserPrompt('<ctx>Fix the login bug</ctx>');
    expect(r.kind).toBe('text');
    expect(r.clean).toBe('Fix the login bug');
  });

  it('drops an inline image path from a mixed prompt but keeps it text', () => {
    const r = classifyUserPrompt('look at this /tmp/shot.png and explain the diff carefully please');
    expect(r.kind).toBe('text');
    expect(r.clean).toContain('[image]');
    expect(r.clean).not.toContain('.png');
  });

  it('does not length-cap the clean text (the recap card shows it in full)', () => {
    const long = 'Implement a feature '.repeat(30);
    const r = classifyUserPrompt(long);
    expect(r.kind).toBe('text');
    expect(r.clean.length).toBeGreaterThan(300);
  });
});

describe('cleanGeneratedSessionLabel (harness auto-title → SessionMeta.label)', () => {
  it('collapses the injected skill-basedir line to /<skill>', () => {
    expect(cleanGeneratedSessionLabel(
      'Base directory for this skill: /home/u/.agents/.history/versions/claude/2.1.207/home/.claude/skills/continue',
    )).toBe('/continue');
  });

  it('leaves an ordinary generated title unchanged', () => {
    expect(cleanGeneratedSessionLabel('Session command audit')).toBe('Session command audit');
  });

  it('does not rewrite a title that merely names a skills/ path', () => {
    expect(cleanGeneratedSessionLabel('rewrite the skills/continue docs'))
      .toBe('rewrite the skills/continue docs');
  });

  it('returns undefined for empty or whitespace-only titles', () => {
    expect(cleanGeneratedSessionLabel(undefined)).toBeUndefined();
    expect(cleanGeneratedSessionLabel('')).toBeUndefined();
    expect(cleanGeneratedSessionLabel('   ')).toBeUndefined();
  });

  // PHNX-3999 F26/F27 — the owner's recording at 07:51–08:03: one row titled with
  // shell-command XML wrappers, others reading `/clear`. A rejected label falls
  // through to the generated title and then the user's own first prompt.
  it('rejects a shell-echo wrapper instead of promoting the command inside it', () => {
    expect(cleanGeneratedSessionLabel('<bash-input>rg TODO src</bash-input>')).toBeUndefined();
    // Stripping the tags would leave "rg TODO src" — a shell command is not a
    // headline either, so the whole label is refused.
    expect(cleanGeneratedSessionLabel('<bash-stdout>142 matches</bash-stdout>')).toBeUndefined();
  });

  it('rejects the other harness scaffolding wrappers a first turn can carry', () => {
    for (const scaffold of [
      '<command-name>/clear</command-name>',
      '<local-command-stdout>Set model to opus</local-command-stdout>',
      '<system-reminder>Remember to run tests</system-reminder>',
      '<persisted-output>Output too large</persisted-output>',
      '[Request interrupted by user]',
    ]) {
      expect(cleanGeneratedSessionLabel(scaffold)).toBeUndefined();
    }
  });

  it('rejects a bare control command, and keeps a command that carries a real task', () => {
    for (const control of ['/clear', '/compact', '/model', '/exit', '/status']) {
      expect(cleanGeneratedSessionLabel(control)).toBeUndefined();
    }
    expect(cleanGeneratedSessionLabel('/continue fix the retry parser'))
      .toBe('/continue fix the retry parser');
  });

  it('still collapses a skill invocation to its /<skill> form (not swallowed by the control rule)', () => {
    expect(cleanGeneratedSessionLabel(
      'Base directory for this skill: /home/u/.agents/skills/recap',
    )).toBe('/recap');
  });

  it('keeps a meaningful title that merely mentions a tag-like token', () => {
    // `1 < 2 > 0` is prose to stripXmlLikeTags, and the label is real work.
    expect(cleanGeneratedSessionLabel('Assert 1 < 2 > 0 in the parser'))
      .toBe('Assert 1 < 2 > 0 in the parser');
  });
});

describe('isSyntheticUserMessage', () => {
  it('flags harness-injected user scaffolding', () => {
    for (const s of [
      '<bash-input>j agents-cli</bash-input>',
      '<bash-stdout>/home/u</bash-stdout><bash-stderr></bash-stderr>',
      '<system-reminder>named this session Foo</system-reminder>',
      '<task-notification>\n<task-id>x</task-id>',
      '<command-name>continue</command-name>',
      '<local-command-stdout>done</local-command-stdout>',
      '<user-prompt-submit-hook>ran</user-prompt-submit-hook>',
      '<persisted-output>x</persisted-output>',
      '<apps_instructions>connector rules</apps_instructions>',
      '<plugins_instructions>plugin rules</plugins_instructions>',
      '<recommended_plugins>plugin catalog</recommended_plugins>',
      '<multi_agent_mode>single agent</multi_agent_mode>',
      '<environment_context><cwd>/home/u/repo</cwd></environment_context>',
      '<user_info>\nOS Version: linux\n<rules>harness dump</rules>\n</user_info>',
      '## In-flight in this repo\nOpen PRs:',
      '## Host & Fleet\nYou are running on box-a.',
      'Your current session id is abc. Session transcript: /home/u/session.jsonl',
      'Linear context skipped: bundle unavailable.',
      '[Request interrupted by user]',
      'Caveat: The messages below were generated by the user while running local commands.',
      'Base directory for this skill: /home/u/.claude/skills/foo',
      'Stop hook feedback:\n[hook.sh]: blocked',
    ]) {
      expect(isSyntheticUserMessage(s)).toBe(true);
    }
  });

  it('does not flag genuine user prose (even with a leading angle bracket of real code)', () => {
    for (const s of [
      'Refactor the auth module and add tests.',
      'Why did the agent claim it was done?',
      '<div>my JSX starts here</div> — fix the layout',
      '<user_query>Refactor the auth module</user_query>',
      undefined,
      '',
    ]) {
      expect(isSyntheticUserMessage(s)).toBe(false);
    }
  });
});

describe('first genuine user message', () => {
  it('skips injected connector scaffolding and preserves the full real turn', () => {
    const real = '# Mission\n\nImplement the Sessions overhaul.\nKeep every existing test green.';
    expect(firstUserMessageFromEvents([
      { type: 'message', agent: 'codex', timestamp: 't0', role: 'user', content: '<recommended_plugins>catalog</recommended_plugins>' },
      { type: 'message', agent: 'codex', timestamp: 't1', role: 'user', content: real },
    ])).toBe(real);
  });

  it('never caps a long genuine request', () => {
    const real = `Build this exactly:\n${'full acceptance detail '.repeat(180)}`;
    expect(cleanFirstUserMessage(real)).toBe(real.trim());
  });

  it('rejects a Grok <user_info> dump and unwraps <user_query>', () => {
    expect(cleanFirstUserMessage(
      '<user_info>\nOS Version: linux\n<rules>never store this dump</rules>\n</user_info>',
    )).toBeUndefined();
    const inner = '## Mission\nIndependently design the product-facing compute tier model.';
    expect(unwrapUserQuery(`<user_query>\n${inner}\n</user_query>`)).toBe(inner);
    expect(cleanFirstUserMessage(`<user_query>\n${inner}\n</user_query>`)).toBe(inner);
  });
});

describe('extractSessionTopic', () => {
  it('returns undefined for empty input', () => {
    expect(extractSessionTopic('')).toBeUndefined();
    expect(extractSessionTopic('   ')).toBeUndefined();
  });

  it('extracts first meaningful line from normal input', () => {
    expect(extractSessionTopic('Fix the login bug')).toBe('Fix the login bug');
  });

  it('skips whole-message patterns', () => {
    expect(extractSessionTopic('<permissions instructions>allow bash</permissions instructions>')).toBeUndefined();
  });

  it('strips HEADLESS PLAN MODE prefix and returns the real task', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX} This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

Fix the authentication bug in login.ts`;
    expect(extractSessionTopic(raw)).toBe('Fix the authentication bug in login.ts');
  });

  it('strips prefix when header has multiple lines before blank line', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX}
Line two of header.
Line three.

Refactor the payment module`;
    expect(extractSessionTopic(raw)).toBe('Refactor the payment module');
  });

  it('returns undefined when prefix is present but no real prompt follows', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX} Some header text with no blank line after`;
    expect(extractSessionTopic(raw)).toBeUndefined();
  });

  it('returns undefined when prefix is present and only whitespace follows blank line', () => {
    const raw = `${HEADLESS_PLAN_MODE_PREFIX} Some header.\n\n   `;
    expect(extractSessionTopic(raw)).toBeUndefined();
  });

  it('does not strip prefix when message does not start with it', () => {
    const msg = 'Normal task that mentions HEADLESS PLAN MODE somewhere in the middle';
    expect(extractSessionTopic(msg)).toBe('Normal task that mentions HEADLESS PLAN MODE somewhere in the middle');
  });

  it('handles leading whitespace before the prefix', () => {
    const raw = `  ${HEADLESS_PLAN_MODE_PREFIX} Header content.\n\nWrite tests for the new feature`;
    expect(extractSessionTopic(raw)).toBe('Write tests for the new feature');
  });
});

describe('cleanSessionPrompt', () => {
  it('removes known noise lines', () => {
    const raw = 'cwd: /workspace\nFix the bug\nshell: bash\n2024-01-01';
    expect(cleanSessionPrompt(raw)).toBe('Fix the bug');
  });

  it('strips XML-like tags', () => {
    expect(cleanSessionPrompt('<context>some info</context>\nDo something')).toBe('some info\nDo something');
  });

  it('strips a tag that a nested tag would reassemble (CodeQL js/incomplete-multi-character-sanitization)', () => {
    expect(cleanSessionPrompt('<scr<b>ipt>alert(1)</scr</b>ipt> Do it')).toBe('alert(1) Do it');
  });

  it('strips deeply nested tag fragments without input-size amplification', () => {
    const depth = 32_000;
    const raw = `<scr${'<a'.repeat(depth)}${'>'.repeat(depth)}ipt>alert(1)</script>`;
    expect(cleanSessionPrompt(raw)).toBe('alert(1)');
  }, 1_000);

  it('returns empty string for whitespace-only input', () => {
    expect(cleanSessionPrompt('   ')).toBe('');
  });
});


describe('tidyRequest over real transcript turns (PHNX-3939)', () => {
  it('keeps the user\'s sentence and pulls the clip, screenshot, @dir and pasted banner out of it', () => {
    // session 82eaa149, turn 4: a clip reference, the dispatch banner the shell
    // echoed, an @../agi-ext mention, an inline screenshot path, and the actual
    // question threaded between them.
    const request = tidyRequest(fixture('clip-paste-mention'), {});
    expect(request).toBeDefined();
    expect(request!.kind).toBe('text');
    expect(request!.headline).toBe(
      'So there is a few issues with the AGI extension, the AGI extension at least when it\'s installed.',
    );
    // The prose is the user's words, verbatim and complete — never a rewrite.
    expect(request!.text).toContain('why was I shown a different version?');
    expect(request!.text).toContain('Please find out any other places where we might have missed this.');
    // …and carries none of the noise.
    expect(request!.text).not.toContain('clip-1788685575.png');
    expect(request!.text).not.toContain('CleanShot');
    expect(request!.text).not.toContain('--strategy balanced');
    expect(request!.text).not.toContain('Resume later:');
    expect(request!.attachments).toEqual([
      { kind: 'image', name: 'clip-1788685575.png' },
      { kind: 'dir', name: '@../agi-ext' },
      { kind: 'image', name: 'CleanShot 2026-09-06 at 02.06.39@2x.png' },
    ]);
    expect(request!.pastedLines).toBeGreaterThanOrEqual(9);
  });

  it('reads the prose inside a slash command\'s <command-args>, keeping the command as a chip', () => {
    // session c9d700d5: `/plan -- Wait hold on…` — the genuine request of the
    // session, which reading the command name alone would have thrown away.
    const request = tidyRequest(fixture('plan-with-prose'), {});
    expect(request?.command).toBe('/plan');
    expect(request?.headline).toBe('/plan · Wait hold on do not create anything.');
    expect(request?.text.startsWith('Wait hold on do not create anything.')).toBe(true);
  });

  it('renders a bare /continue <id> as the command it is, with no invented prose', () => {
    const request = tidyRequest(fixture('continue-command'), {});
    expect(request).toEqual({
      kind: 'skill',
      command: '/continue 8231082e',
      text: '',
      headline: '/continue 8231082e',
      attachments: [],
      pastedLines: 0,
    });
  });

  it('rejects the two turns that used to become a session title', () => {
    // The <local-command-stdout> echo of `/model`, and a skill body — both
    // accepted by the old topic list and rejected by the turn cleaner.
    expect(tidyRequest(fixture('model-echo'), {})).toBeUndefined();
    expect(tidyRequest(fixture('skill-body'), {})).toBeUndefined();
    expect(extractSessionTopic(fixture('model-echo'))).toBeUndefined();
    expect(extractSessionTopic(fixture('skill-body'))).toBeUndefined();
  });

  it('folds an image-only turn to [image] using the row\'s recorded attachments', () => {
    const request = tidyRequest('/Users/dev/Screenshots/shot.png', {
      attachments: [{ name: 'shot.png', mediaType: 'image/png' }],
    });
    expect(request?.kind).toBe('image');
    expect(request?.headline).toBe('[image]');
    expect(request?.attachments).toEqual([{ kind: 'image', name: 'shot.png' }]);
  });

  it('unwraps a <user_query> wrapper and never rewrites the prose inside it', () => {
    const request = tidyRequest('<user_query>Fix the flaky watcher test.</user_query>', {});
    expect(request?.text).toBe('Fix the flaky watcher test.');
    expect(request?.headline).toBe('Fix the flaky watcher test.');
  });

  it('headlines the ask, not the markdown heading that labels it', () => {
    // A briefed agent's prompt opens `## Mission` — the section label, not the
    // request. Headlining that read "Mission" on the row.
    const request = tidyRequest('## Mission\nShip the CLI half of the sidebar timeline. Then stop.', {});
    expect(request?.headline).toBe('Ship the CLI half of the sidebar timeline.');
    // The full text still carries every word the user wrote, heading included.
    expect(request?.text).toBe('## Mission Ship the CLI half of the sidebar timeline. Then stop.');
  });

  it('keeps a heading-only turn rather than inventing a line under it', () => {
    expect(tidyRequest('# Ship the release', {})?.headline).toBe('Ship the release');
  });

  it('treats a pasted TUI frame as terminal echo, not as the request', () => {
    // Observed live: a pasted panel row headlined the session as
    // "│ script (hooks, daemon, ext, menubar) What do you mean by …".
    const request = tidyRequest(
      '│ script (hooks, daemon, ext, menubar)\n╰──────────────╯\nWhat do you mean by script here?',
      {},
    );
    expect(request?.headline).toBe('What do you mean by script here?');
    expect(request?.pastedLines).toBe(2);
  });

  it('drops a leading bare session id from the headline but keeps it in the text', () => {
    // `agents message <id> <text>` arrives as `<uuid> Hey Claude …`; the id is
    // addressing, and it headlined the row before this.
    const request = tidyRequest('41305148-5f40-4621-af5e-c5218a493891 Hey Claude, can you re-run the release?', {});
    expect(request?.headline).toBe('Hey Claude, can you re-run the release?');
    expect(request?.text).toContain('41305148-5f40-4621-af5e-c5218a493891');
  });

  it('returns undefined for scaffolding and for an empty turn', () => {
    expect(tidyRequest('<system-reminder>ignore me</system-reminder>', {})).toBeUndefined();
    expect(tidyRequest('   ', {})).toBeUndefined();
    expect(tidyRequest(undefined, {})).toBeUndefined();
  });
});

describe('the topic list and the turn list are one list (PHNX-3939)', () => {
  const rejected = [
    '<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>',
    '<local-command-stderr>boom</local-command-stderr>',
    '<local-command-caveat>Caveat: The messages below were generated by the user</local-command-caveat>',
    'Base directory for this skill: /home/dev/.agents/skills/plan',
    'Stop hook feedback: open PR still red',
    '<hook_result>blocked</hook_result>',
    '<notification>agent finished</notification>',
    '<bash-input>ls -la</bash-input>',
    '<bash-stdout>total 0</bash-stdout>',
    '[Request interrupted by user]',
    '**`/plan` routes to the swarm:plan skill**',
    'Skill tool loaded instructions for plan',
    '[SYSTEM NOTIFICATION] a teammate finished',
    '[Image: original 3840x1526, displayed at 2000x795.]',
  ];

  it('rejects every synthetic shape for BOTH extractSessionTopic and cleanFirstUserMessage', () => {
    for (const raw of rejected) {
      expect(isSyntheticUserMessage(raw), raw).toBe(true);
      expect(cleanFirstUserMessage(raw), raw).toBeUndefined();
      expect(extractSessionTopic(raw), raw).toBeUndefined();
    }
  });

  it('still accepts a genuine turn that merely mentions one of those words', () => {
    const raw = 'The stop hook feedback loop is wrong — please fix it.';
    expect(isSyntheticUserMessage(raw)).toBe(false);
    expect(extractSessionTopic(raw)).toBe(raw);
  });
});

describe('lastUserMessageFromEvents', () => {
  const turn = (content: string, synthetic = false): SessionEvent => ({
    type: 'message', agent: 'claude', timestamp: '2026-09-06T00:00:00.000Z', role: 'user', content,
    ...(synthetic ? { _synthetic: true } : {}),
  });

  it('returns the LATEST genuine turn, not the first', () => {
    const events = [turn('Start the migration.'), turn('<system-reminder>x</system-reminder>', true), turn('Actually, revert it.')];
    expect(firstUserMessageFromEvents(events)).toBe('Start the migration.');
    expect(lastUserMessageFromEvents(events)).toBe('Actually, revert it.');
  });

  it('skips synthetic trailing scaffolding to reach the real last turn', () => {
    const events = [turn('Ship the fix.'), turn('<task-notification>done</task-notification>', true)];
    expect(lastUserMessageFromEvents(events)).toBe('Ship the fix.');
  });

  it('returns undefined when every turn is scaffolding', () => {
    expect(lastUserMessageFromEvents([turn('<bash-input>ls</bash-input>', true)])).toBeUndefined();
  });
});
