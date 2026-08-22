import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type * as vscode from 'vscode';

// Minimal vscode mock
mock.module('vscode', () => ({
  window: {
    terminals: [],
    onDidCloseTerminal: () => ({ dispose: () => {} }),
    onDidOpenTerminal: () => ({ dispose: () => {} }),
    onDidChangeActiveTerminal: () => ({ dispose: () => {} }),
    onDidChangeTabs: () => ({ dispose: () => {} }),
  },
  workspace: { workspaceFolders: undefined },
  TabInputTerminal: class {},
  window2: undefined,
}));

mock.module('./agents.vscode', () => ({
  getBuiltInByKey: () => undefined,
}));



mock.module('../core/sessions.persist', () => ({
  buildPersistedSessions: () => [],
  savePersistedSessions: () => {},
  loadPersistedSessions: () => [],
  clearPersistedSessions: () => {},
  getWorkspaceSessions: () => [],
  persistWorkspaceSessions: () => {},
  updatePersistedSession: () => {},
  PersistedSession: {},
}));

const t = await import('./terminals.vscode');

function fakeTerm(name: string): vscode.Terminal {
  return { name, processId: Promise.resolve(undefined) } as unknown as vscode.Terminal;
}

function fakeAgentConfig() {
  return {
    title: 'Claude',
    command: 'claude',
    icon: undefined,
    prefix: 'CC',
    iconPath: undefined,
  } as any;
}

beforeEach(() => {
  t.clear();
});

afterEach(() => {
  // Terminals tests mock vscode and sibling modules globally; restore so later
  // test files (htmlReader, session-read, etc.) load the real modules.
  mock.restore();
});

// ─── Bug proofs ───────────────────────────────────────────────────────────────

describe('BUG C: setSessionId clears autoLabel on session change', () => {
  test('autoLabel is cleared by setSessionId when an existing session changes', () => {
    const term = fakeTerm('CC-bug-c');
    t.register(term, 'CC-001', fakeAgentConfig(), undefined);
    t.setSessionId(term, 'old-session-id-aaaa');

    // Simulate a label being set after first session adoption
    t.setAutoLabel(term, 'fix the auth bug');

    const before = t.getByTerminal(term);
    expect(before?.autoLabel).toBe('fix the auth bug');

    // Session changes (e.g. /continue creates a new session)
    t.setSessionId(term, 'new-session-id-aaaa');

    const after = t.getByTerminal(term);
    expect(after?.autoLabel).toBeUndefined();
    expect(after?.sessionId).toBe('new-session-id-aaaa');
  });
});

describe('automatic-label persistence', () => {
  test('buildPersistedSessions keeps the automatic label provenance', () => {
    const term = fakeTerm('CC-auto-label');
    t.register(term, 'CC-auto', fakeAgentConfig(), undefined);
    t.setSessionId(term, 'session-auto');
    t.setAutoLabel(term, 'Release the project');

    expect(t.buildPersistedSessions()).toEqual([
      expect.objectContaining({
        terminalId: 'CC-auto',
        label: undefined,
        autoLabel: 'Release the project',
      }),
    ]);
  });
});

describe('BUG A: startAutoLabelPoller guard blocks restart once autoLabel is set', () => {
  test('pollFn is never called when autoLabel is already set', async () => {
    const term = fakeTerm('CC-bug-a');
    t.register(term, 'CC-002', fakeAgentConfig(), undefined);

    // Label was set from a previous session
    t.setAutoLabel(term, 'old label from session 1');

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });

    // Give the poller time to fire if it were running
    await new Promise(r => setTimeout(r, 50));

    // BUG: pollFn never called — guard `if (entry.autoLabel || entry.label) return` fires
    expect(pollCount).toBe(0);
  });

  test('pollFn IS called when autoLabel is not set', async () => {
    const term = fakeTerm('CC-no-bug');
    t.register(term, 'CC-003', fakeAgentConfig(), undefined);

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });

    await new Promise(r => setTimeout(r, 50));

    // Without a label, the poller starts and fires immediately
    expect(pollCount).toBeGreaterThan(0);

    t.stopAutoLabelPoller(term);
  });
});

describe('BUG A+B+C: full chain — session changes allow label refresh', () => {
  test('after onSessionChanged fires, label poller can restart because autoLabel is cleared', async () => {
    const term = fakeTerm('CC-full-chain');
    t.register(term, 'CC-004', fakeAgentConfig(), undefined);

    // Session 1 is adopted and labelled
    t.setSessionId(term, 'session-1');
    t.setAutoLabel(term, 'label from session 1');

    // Session changes (simulating onSessionChanged handler in extension.ts:596-600)
    t.setSessionId(term, 'session-2');
    // setSessionId clears autoLabel so startAutoLabelPoller is not blocked by the old label

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });
    await new Promise(r => setTimeout(r, 50));

    expect(pollCount).toBeGreaterThan(0);

    const entry = t.getByTerminal(term);
    expect(entry?.sessionId).toBe('session-2');      // session updated
    expect(entry?.autoLabel).toBeUndefined();
  });
});

describe('BUG I: setLabel immediately stops autoLabelPoller', () => {
  test('poller interval is cleared after manual label is set via setLabel', async () => {
    const term = fakeTerm('CC-bug-i');
    t.register(term, 'CC-005', fakeAgentConfig(), undefined);

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => {
      pollCount++;
      // Simulate the poller setting the autoLabel on first run
      t.setAutoLabel(term, 'auto-generated');
    }, 50);

    await new Promise(r => setTimeout(r, 30));
    expect(pollCount).toBe(1); // immediate fire on start

    // User sets a manual label (Cmd+L), which stops the interval immediately
    const fakeContext = undefined as any;
    await t.setLabel(term, 'manual label', fakeContext);

    const entry = t.getByTerminal(term);
    expect(entry?.autoLabelPollerId).toBeUndefined();

    t.stopAutoLabelPoller(term);
  });
});

// Half of the status-bar identity fix (Defect 2): a harness the CLI records no
// version for (Kimi) must not keep a version left over from a prior binding in the
// same terminal. setVersion(null) has to CLEAR, not be ignored.
describe('setVersion clears the cached version on null/empty', () => {
  test('a null version wipes both version and statusVersion', () => {
    const term = fakeTerm('CC-setver');
    t.register(term, 'CC-ver-1', fakeAgentConfig(), undefined);

    t.setVersion(term, '2.1.218');
    const set = t.getByTerminal(term);
    expect(set?.version).toBe('2.1.218');
    expect(set?.statusVersion).toBe('2.1.218');

    // Re-hydration for a session the CLI has no version for must clear it.
    t.setVersion(term, null);
    const cleared = t.getByTerminal(term);
    expect(cleared?.version).toBeUndefined();
    expect(cleared?.statusVersion).toBeUndefined();
  });

  test('an empty/whitespace version is treated as clear, not a literal value', () => {
    const term = fakeTerm('CC-setver2');
    t.register(term, 'CC-ver-2', fakeAgentConfig(), undefined);
    t.setVersion(term, '2.1.218');
    t.setVersion(term, '   ');
    expect(t.getByTerminal(term)?.version).toBeUndefined();
  });
});
