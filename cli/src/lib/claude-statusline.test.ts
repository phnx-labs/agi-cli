import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_STATUSLINE_COMMAND,
  claudeHomeFromEnv,
  formatAccountPart,
  formatReminderPart,
  ingestClaudeStatusLineUsage,
  installClaudeStatusLine,
  isStatusLineSelfReference,
  renderClaudeStatusLine,
  readClaudeIdentity,
  renderDelegate,
  resolveReminderPart,
} from './claude-statusline.js';
import { findNativeAccountByIdentity } from './account-registry.js';
import { setRemindersFilePathForTest } from './reminders.js';
import {
  readClaudeUsageCache,
  setClaudeUsageCachePathForTest,
  writeClaudeUsageCache,
} from './accounting/usage.js';

const dirs: string[] = [];
let priorCachePath: string | null = null;

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-statusline-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  if (priorCachePath !== null) setClaudeUsageCachePathForTest(priorCachePath);
  priorCachePath = null;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Claude native status line', () => {
  it('renders hostname, active model, delegated output, and native quota windows', () => {
    expect(renderClaudeStatusLine({
      model: { display_name: 'Opus 5' },
      rate_limits: {
        five_hour: { used_percentage: 1 },
        seven_day: { used_percentage: 80 },
      },
    }, 'zion', 'agents-cli · rush-3194')).toBe(
      'zion · Opus 5 · agents-cli · rush-3194 · 5h 1% · 7d 80%',
    );
  });

  it('renders the signed-in account between the host and the model', () => {
    expect(renderClaudeStatusLine({
      model: { display_name: 'Fable 5.1' },
      rate_limits: { five_hour: { used_percentage: 16 }, seven_day: { used_percentage: 8 } },
    }, 'yosemite-s1', '', formatReminderPart('Conviction gives permission'), 'person@example.com')).toBe(
      'yosemite-s1 · person@example.com · Fable 5.1 · 5h 16% · 7d 8% · \x1b[2m◆ Conviction gives permission\x1b[22m',
    );
    expect(renderClaudeStatusLine({ model: { display_name: 'Opus 5' } }, 'zion', '', '', '')).toBe(
      'zion · Opus 5',
    );
  });

  it('formats the account from the identity of the home Claude is actually running with', () => {
    // The shim's version home: CLAUDE_CONFIG_DIR/.claude.json is the file Claude uses.
    const versionHome = tempHome();
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(versionHome, '.claude', '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: 'person@example.com',
        accountUuid: 'account-1',
        organizationUuid: 'org-1',
        organizationType: 'claude_max',
        organizationName: "person@example.com's Organization",
      },
    }));
    expect(claudeHomeFromEnv({ CLAUDE_CONFIG_DIR: path.join(versionHome, '.claude') })).toBe(versionHome);
    // A personal plan shows the bare email — the auto-generated org name is not identity.
    expect(formatAccountPart(readClaudeIdentity(versionHome), null)).toBe('person@example.com');

    // A multi-seat Team seat carries its org name, the same label `agents view` renders.
    const teamHome = tempHome();
    fs.writeFileSync(path.join(teamHome, '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: 'seat@example.com',
        accountUuid: 'account-2',
        organizationUuid: 'org-2',
        organizationType: 'claude_team',
        organizationName: 'Example Labs',
      },
    }));
    expect(formatAccountPart(readClaudeIdentity(teamHome), null)).toBe('seat@example.com (Example Labs)');

    // No CLAUDE_CONFIG_DIR → Claude reads $HOME/.claude.json; a never-signed-in home renders nothing.
    expect(claudeHomeFromEnv({})).toBe(os.homedir());
    expect(formatAccountPart(readClaudeIdentity(tempHome()), null)).toBe('');
  });

  it('renders the registered account NAME for a named login, the email only when unnamed', () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'person@example.com', accountUuid: 'account-1', organizationUuid: 'org-1' },
    }));
    const identity = readClaudeIdentity(home);
    // The same registry row `agents accounts` lists as `claude  work  person@example.com`.
    const meta = {
      accounts: {
        native: {
          'acct-work': {
            id: 'acct-work', name: 'work', agent: 'claude' as const,
            identityKey: identity!.accountKey!, identityLabel: 'person@example.com', scope: 'device' as const,
          },
          'acct-cx': {
            id: 'acct-cx', name: 'cxwork', agent: 'codex' as const,
            identityKey: 'person@example.com', scope: 'device' as const,
          },
        },
      },
    };
    const named = findNativeAccountByIdentity(meta, 'claude', identity);
    expect(named?.name).toBe('work');
    expect(formatAccountPart(identity, named)).toBe('work');
    // A different harness's row for the same human never names a Claude login.
    expect(findNativeAccountByIdentity(meta, 'codex', identity)).toBeNull();
    // Unnamed login: nothing registered for this identity → the email label.
    expect(findNativeAccountByIdentity({ accounts: {} }, 'claude', identity)).toBeNull();
    expect(formatAccountPart(identity, null)).toBe('person@example.com');
    expect(findNativeAccountByIdentity(meta, 'claude', null)).toBeNull();
  });

  it('appends a dimmed reminder part after the usage windows when present', () => {
    expect(renderClaudeStatusLine({
      model: { display_name: 'Opus 5' },
      rate_limits: { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 80 } },
    }, 'zion', '', formatReminderPart('Move with confidence'))).toBe(
      'zion · Opus 5 · 5h 1% · 7d 80% · \x1b[2m◆ Move with confidence\x1b[22m',
    );
  });

  it('omits the reminder part when there is no reminder', () => {
    expect(formatReminderPart(undefined)).toBe('');
    expect(formatReminderPart('  ')).toBe('');
    expect(renderClaudeStatusLine({ model: { display_name: 'Opus 5' } }, 'zion', '', '')).toBe(
      'zion · Opus 5',
    );
  });

  it('resolveReminderPart returns a reminder from the real path, and swallows a malformed file', () => {
    const remDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'));
    dirs.push(remDir);
    const remFile = path.join(remDir, 'reminders.yaml');
    const prior = setRemindersFilePathForTest(remFile);
    try {
      // Valid file → a dimmed reminder part on the real (default-path) code path.
      fs.writeFileSync(remFile, ['reminders:', '  - short: "Only one"'].join('\n'));
      expect(resolveReminderPart('sess-x')).toBe('\x1b[2m◆ Only one\x1b[22m');

      // Malformed file → swallowed to '' so the prompt is never broken (the
      // feature's central safety claim, exercised on the real path).
      fs.writeFileSync(remFile, 'not-a-reminders-doc: true');
      expect(resolveReminderPart('sess-x')).toBe('');

      // Missing file → not opted in → ''.
      fs.rmSync(remFile);
      expect(resolveReminderPart('sess-x')).toBe('');
    } finally {
      setRemindersFilePathForTest(prior);
    }
  });

  it('writes a native response snapshot under the version home organization identity', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: 'person@example.com',
        accountUuid: 'account-1',
        organizationUuid: 'org-1',
      },
    }));
    priorCachePath = setClaudeUsageCachePathForTest(path.join(home, 'usage.json'));
    writeClaudeUsageCache('claude:org=org-1', {
      source: 'live',
      sourceLabel: 'prior live usage',
      capturedAt: new Date(),
      windows: [],
      plan: 'Max',
    });

    expect(ingestClaudeStatusLineUsage({
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 1_800_000_000 },
        seven_day: { used_percentage: 34, resets_at: 1_800_100_000 },
      },
    }, readClaudeIdentity(home))).toBe(true);

    const snapshot = readClaudeUsageCache('claude:org=org-1');
    expect(snapshot?.source).toBe('last_seen');
    expect(snapshot?.windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ['session', 12],
      ['week', 34],
    ]);

    expect(ingestClaudeStatusLineUsage({
      rate_limits: {
        five_hour: { used_percentage: 56, resets_at: 1_800_200_000 },
      },
    }, readClaudeIdentity(home))).toBe(true);

    const partialSnapshot = readClaudeUsageCache('claude:org=org-1');
    expect(partialSnapshot?.plan).toBe('Max');
    expect(partialSnapshot?.windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ['session', 56],
      ['week', 34],
    ]);
  });

  it('does not erase the cache when Claude omits rate_limits', () => {
    const home = tempHome();
    expect(ingestClaudeStatusLineUsage({}, readClaudeIdentity(home))).toBe(false);
  });

  it('wraps and preserves a pre-existing status-line command', () => {
    const home = tempHome();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      customTopLevel: { keep: true },
      statusLine: {
        type: 'command',
        command: '/home/me/statusline.sh',
        padding: 2,
        refreshInterval: 7,
        customField: 'keep',
      },
    }));

    expect(installClaudeStatusLine(home)).toEqual({ changed: true });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.customTopLevel).toEqual({ keep: true });
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: CLAUDE_STATUSLINE_COMMAND,
      padding: 2,
      refreshInterval: 7,
      customField: 'keep',
    });
    expect(fs.readFileSync(path.join(home, '.agents', 'claude-statusline-delegate'), 'utf8')).toBe(
      '/home/me/statusline.sh\n',
    );
    expect(installClaudeStatusLine(home)).toEqual({ changed: false });
  });

  it('recognizes our own subcommand under any binary name as a self-reference', () => {
    // The exact production command, and the fork-bomb seeds: the same private
    // subcommand under a different binary name or an absolute path.
    expect(isStatusLineSelfReference(CLAUDE_STATUSLINE_COMMAND)).toBe(true);
    expect(isStatusLineSelfReference('agents-dev __claude-statusline')).toBe(true);
    expect(isStatusLineSelfReference('ag __claude-statusline')).toBe(true);
    expect(isStatusLineSelfReference('/Users/me/.local/bin/agents-dev __claude-statusline')).toBe(true);
    expect(isStatusLineSelfReference('  agents   __claude-statusline  ')).toBe(true);
    // A genuine third-party producer is NOT a self-reference.
    expect(isStatusLineSelfReference('/home/me/statusline.sh')).toBe(false);
    expect(isStatusLineSelfReference('starship prompt')).toBe(false);
    expect(isStatusLineSelfReference('')).toBe(false);
  });

  it('never saves our own command (under a dev binary name) as a delegate — the fork bomb', () => {
    // Reproduces the fork-bomb seed: settings.json points the status line at `agents-dev
    // __claude-statusline`, which must not be preserved as a delegate or every render spawns
    // another.
    const home = tempHome();
    const delegate = path.join(home, '.agents', 'claude-statusline-delegate');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'agents-dev __claude-statusline' },
    }));

    expect(installClaudeStatusLine(home)).toEqual({ changed: true });
    // No recursive delegate was written.
    expect(fs.existsSync(delegate)).toBe(false);
    // The command was canonicalized to the production entrypoint.
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command)
      .toBe(CLAUDE_STATUSLINE_COMMAND);
  });

  it('deletes a pre-existing recursive delegate on re-install', () => {
    // A box already poisoned by the bomb: the delegate file itself holds our own
    // subcommand. Re-installing must remove it, not leave it to keep recursing.
    const home = tempHome();
    const delegate = path.join(home, '.agents', 'claude-statusline-delegate');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(delegate), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(delegate, 'agents-dev __claude-statusline\n');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'agents-dev __claude-statusline' },
    }));

    expect(installClaudeStatusLine(home)).toEqual({ changed: true });
    expect(fs.existsSync(delegate)).toBe(false);
  });

  it('renderDelegate runs a genuine external delegate and returns its output', () => {
    const home = tempHome();
    const delegate = path.join(home, '.agents', 'claude-statusline-delegate');
    fs.mkdirSync(path.dirname(delegate), { recursive: true });
    fs.writeFileSync(delegate, 'printf custom-status\n');
    expect(renderDelegate('', home)).toBe('custom-status');
  });

  it('renderDelegate never SPAWNS a self-referencing delegate — the read-side fork-bomb guard', () => {
    const home = tempHome();
    const delegate = path.join(home, '.agents', 'claude-statusline-delegate');
    const sentinel = path.join(home, 'delegate-was-spawned');
    fs.mkdirSync(path.dirname(delegate), { recursive: true });
    // A self-referencing delegate that would create a sentinel file if executed. The pre-fix
    // exact-string guard spawned and recursed; the fix must return '' without running it.
    fs.writeFileSync(delegate, `sh -c 'touch "${sentinel}"' __claude-statusline\n`);
    expect(renderDelegate('', home)).toBe('');
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('renderDelegate refuses a second hop when already running as a delegate (one-hop backstop)', () => {
    const home = tempHome();
    const delegate = path.join(home, '.agents', 'claude-statusline-delegate');
    fs.mkdirSync(path.dirname(delegate), { recursive: true });
    // A perfectly valid external producer — but the env marker says we are
    // ourselves a delegate, so it must NOT be spawned (hard depth-1 cap).
    fs.writeFileSync(delegate, 'printf should-not-run\n');
    const prior = process.env.AGENTS_CLAUDE_STATUSLINE_DELEGATED;
    process.env.AGENTS_CLAUDE_STATUSLINE_DELEGATED = '1';
    try {
      expect(renderDelegate('', home)).toBe('');
    } finally {
      if (prior === undefined) delete process.env.AGENTS_CLAUDE_STATUSLINE_DELEGATED;
      else process.env.AGENTS_CLAUDE_STATUSLINE_DELEGATED = prior;
    }
  });

  it('does not resurrect a removed custom status-line command', () => {
    const home = tempHome();
    const delegate = path.join(home, '.agents', 'claude-statusline-delegate');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(delegate), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(delegate, '/home/me/removed-statusline.sh\n');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { padding: 4 } }));

    expect(installClaudeStatusLine(home)).toEqual({ changed: true });
    expect(fs.existsSync(delegate)).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine).toEqual({
      padding: 4,
      type: 'command',
      command: CLAUDE_STATUSLINE_COMMAND,
    });
  });
});
