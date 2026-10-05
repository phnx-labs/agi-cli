import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let SYSTEM_DIR: string;
let USER_DIR: string;

vi.mock('../state.js', async (importActual) => ({
  ...(await importActual<typeof import('../state.js')>()),
  get getAgentsDir() { return () => SYSTEM_DIR; },
  get getSystemAgentsDir() { return () => SYSTEM_DIR; },
  get getUserAgentsDir() { return () => USER_DIR; },
  get getCommandsDir() { return () => path.join(SYSTEM_DIR, 'commands'); },
  get getSystemCommandsDir() { return () => path.join(SYSTEM_DIR, 'commands'); },
  get getUserCommandsDir() { return () => path.join(USER_DIR, 'commands'); },
  get getSkillsDir() { return () => path.join(SYSTEM_DIR, 'skills'); },
  get getSystemSkillsDir() { return () => path.join(SYSTEM_DIR, 'skills'); },
  get getUserSkillsDir() { return () => path.join(USER_DIR, 'skills'); },
  get getProjectAgentsDir() { return () => null; },
  get getEnabledExtraRepos() { return () => []; },
  get ensureAgentsDir() { return () => fs.mkdirSync(USER_DIR, { recursive: true }); },
}));

vi.mock('../agents.js', () => ({
  AGENTS: {},
  ALL_AGENT_IDS: [],
  COMMANDS_CAPABLE_AGENTS: [],
  SKILLS_CAPABLE_AGENTS: [],
}));

vi.mock('../command-skills.js', () => ({
  isCommandSkillCapableAgent: () => false,
  installCommandSkillToVersion: () => ({ success: true }),
}));

import { installCommandCentrally } from '../commands.js';

describe('agents X add writes to user repo', () => {
  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'add-target-'));
    SYSTEM_DIR = path.join(TEST_ROOT, '.agents-system');
    USER_DIR = path.join(TEST_ROOT, '.agents');
    fs.mkdirSync(path.join(SYSTEM_DIR, 'commands'), { recursive: true });
    fs.mkdirSync(USER_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('installCommandCentrally lands the file in the user repo', () => {
    const sourcePath = path.join(TEST_ROOT, 'source.md');
    fs.writeFileSync(sourcePath, '---\ndescription: test\n---\n\nhello\n');

    const result = installCommandCentrally(sourcePath, 'mycmd');

    expect(result.success).toBe(true);
    expect(result.path.startsWith(USER_DIR)).toBe(true);
    expect(result.path.startsWith(SYSTEM_DIR)).toBe(false);
    expect(fs.existsSync(path.join(USER_DIR, 'commands', 'mycmd.md'))).toBe(true);
    expect(fs.existsSync(path.join(SYSTEM_DIR, 'commands', 'mycmd.md'))).toBe(false);
  });

  it('does not write into the system repo even if user repo is empty', () => {
    fs.rmSync(USER_DIR, { recursive: true, force: true });
    const sourcePath = path.join(TEST_ROOT, 'source.md');
    fs.writeFileSync(sourcePath, '---\ndescription: x\n---\n\nbody\n');

    const result = installCommandCentrally(sourcePath, 'fresh');

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(USER_DIR, 'commands', 'fresh.md'))).toBe(true);
    expect(fs.existsSync(path.join(SYSTEM_DIR, 'commands', 'fresh.md'))).toBe(false);
  });
});
