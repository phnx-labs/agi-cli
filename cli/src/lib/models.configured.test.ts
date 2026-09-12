import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// resolveConfiguredModel walks: run-default (agents.yaml) -> the agent's native
// settings.json -> the CLI's built-in default. state/versions resolve HOME at
// import time, so we point HOME at a throwaway dir and re-import fresh per test.
let TMP: string;

async function freshModels() {
  vi.resetModules();
  return import('./models.js');
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** The agents.yaml run-default that layer 1 reads. */
function setRunDefault(model: string) {
  const yaml = `run:\n  defaults:\n    "claude:*":\n      model: ${model}\n`;
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.agents', 'agents.yaml'), yaml);
}

/** The agent's OWN native settings.json that layer 2 reads. */
function setNativeModel(version: string, model: string) {
  writeJson(
    path.join(TMP, '.agents', '.history', 'versions', 'claude', version, 'home', '.claude', 'settings.json'),
    { model },
  );
}

describe('resolveConfiguredModel precedence', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cfgmodel-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('prefers the agents.yaml run default over everything', async () => {
    setRunDefault('opus');
    setNativeModel('9.9.9', 'sonnet'); // present, but run default must win
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('claude', '9.9.9')).toEqual({ model: 'opus', source: 'run-default' });
  });

  it("falls back to the agent's native settings.json model", async () => {
    setNativeModel('9.9.9', 'sonnet'); // no run default configured
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('claude', '9.9.9')).toEqual({ model: 'sonnet', source: 'config' });
  });

  it('returns null when nothing is configured and no model catalog exists', async () => {
    // No run default, no settings.json model, and no installed binary/bundle in
    // the temp HOME -> no catalog -> nothing to report.
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('claude', '9.9.9')).toBeNull();
  });

  it('ignores a blank/malformed native model and falls through', async () => {
    writeJson(
      path.join(TMP, '.agents', '.history', 'versions', 'claude', '9.9.9', 'home', '.claude', 'settings.json'),
      { model: '   ' },
    );
    const { resolveConfiguredModel } = await freshModels();
    // blank model is not a real selection; with no catalog it resolves to null
    expect(resolveConfiguredModel('claude', '9.9.9')).toBeNull();
  });
});

describe('resolveConfiguredModel — OpenCode', () => {
  // OpenCode reads ~/.config/opencode/opencode.{jsonc,json}, NOT the
  // .opencode/settings.json every Claude-shaped harness uses, and ships no
  // default model — it persists the TUI's pick to $XDG_STATE_HOME/opencode.
  let prevXdgState: string | undefined;
  let prevRealHome: string | undefined;

  const versionHome = () =>
    path.join(TMP, '.agents', '.history', 'versions', 'opencode', '1.18.15', 'home');

  function setOpenCodeConfig(model: string | undefined, ext: 'jsonc' | 'json' = 'jsonc') {
    const file = path.join(versionHome(), '.config', 'opencode', `opencode.${ext}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = model === undefined ? '{}' : JSON.stringify({ model });
    fs.writeFileSync(file, `// OpenCode config\n${body}\n`);
  }

  function setSelectedModel(recent: Array<{ providerID?: string; modelID?: string }>) {
    const file = path.join(versionHome(), '.local', 'state', 'opencode', 'model.json');
    writeJson(file, { recent, favorite: [] });
  }

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cfgmodel-oc-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    // Keep the developer's real ~/.local/state/opencode out of the resolution.
    prevXdgState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-xdgstate-'));
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_REAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-realhome-'));
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdgState;
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("reads model from OpenCode's own opencode.jsonc, comments and all", async () => {
    setOpenCodeConfig('anthropic/claude-sonnet-4');
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('opencode', '1.18.15')).toEqual({
      model: 'anthropic/claude-sonnet-4',
      source: 'config',
    });
  });

  it('accepts the opencode.json spelling too', async () => {
    setOpenCodeConfig('openai/gpt-5.6', 'json');
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('opencode', '1.18.15')?.model).toBe('openai/gpt-5.6');
  });

  it('never reads a model from .opencode/settings.json, which is not OpenCode config', async () => {
    // That file is agents-cli's plugin-enablement file. Treating it as OpenCode
    // config is what this fixes; it must not become a model source now either.
    writeJson(path.join(versionHome(), '.opencode', 'settings.json'), { model: 'wrong/model' });
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('opencode', '1.18.15')?.model).not.toBe('wrong/model');
  });

  it("falls back to OpenCode's persisted TUI selection when nothing is configured", async () => {
    setOpenCodeConfig(undefined);
    setSelectedModel([
      { providerID: 'opencode', modelID: 'muse-spark-1.3' },
      { providerID: 'openai', modelID: 'gpt-5.6-terra-fast' },
    ]);
    const { resolveConfiguredModel } = await freshModels();
    // recent[0] is the current pick, spelled the way OpenCode's config spells it.
    expect(resolveConfiguredModel('opencode', '1.18.15')).toEqual({
      model: 'opencode/muse-spark-1.3',
      source: 'cli-default',
    });
  });

  it('prefers an explicit config model over the persisted selection', async () => {
    setOpenCodeConfig('anthropic/claude-sonnet-4');
    setSelectedModel([{ providerID: 'opencode', modelID: 'muse-spark-1.3' }]);
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('opencode', '1.18.15')?.model).toBe('anthropic/claude-sonnet-4');
  });

  it('resolves the selection from $XDG_STATE_HOME when the version home has none', async () => {
    const file = path.join(process.env.XDG_STATE_HOME!, 'opencode', 'model.json');
    writeJson(file, { recent: [{ providerID: 'meta', modelID: 'muse-spark-1.1' }] });
    const { resolveConfiguredModel } = await freshModels();
    expect(resolveConfiguredModel('opencode', '1.18.15')?.model).toBe('meta/muse-spark-1.1');
  });

  it('ignores an empty or malformed model.json rather than throwing', async () => {
    setSelectedModel([]);
    const { resolveConfiguredModel } = await freshModels();
    // No catalog in the temp HOME either, so there is simply nothing to report.
    expect(resolveConfiguredModel('opencode', '1.18.15')).toBeNull();
  });
});

describe('formatAgentIdentity', () => {
  it('joins pieces with a separator and drops empty ones', async () => {
    const { formatAgentIdentity } = await freshModels();
    // Split on the middot so the test is agnostic to chalk color codes.
    const parts = (s: string) => s.split('·').map((p) => p.trim()).filter(Boolean);
    expect(parts(formatAgentIdentity('claude@2.1.186', 'opus', 'you@rush.dev'))).toEqual([
      'claude@2.1.186',
      'opus',
      'you@rush.dev',
    ]);
    expect(parts(formatAgentIdentity('claude@2.1.186', null, 'you@rush.dev'))).toEqual([
      'claude@2.1.186',
      'you@rush.dev',
    ]);
    expect(formatAgentIdentity('solo')).toBe('solo');
    expect(formatAgentIdentity(null, undefined, '')).toBe('');
  });
});
