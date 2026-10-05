import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TEST_VERSIONS_DIR = '';
let TEST_BACKUPS_DIR = '';

vi.mock('../state.js', async () => {
  const actual = await vi.importActual<typeof import('../state.js')>('../state.js');
  return {
    ...actual,
    getVersionsDir: () => TEST_VERSIONS_DIR,
    getBackupsDir: () => TEST_BACKUPS_DIR,
    ensureAgentsDir: () => {},
  };
});

import { switchConfigSymlink } from './shims.js';
import { getDB, querySessions } from '../session/db.js';

const tempDirs: string[] = [];
const insertedSessionIds: string[] = [];

function makeTempHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shims-session-rewrite-'));
  tempDirs.push(root);
  TEST_VERSIONS_DIR = path.join(root, '.agents', 'versions');
  TEST_BACKUPS_DIR = path.join(root, '.agents', 'backups');
  fs.mkdirSync(TEST_VERSIONS_DIR, { recursive: true });
  process.env.AGENTS_REAL_HOME = root;
  return root;
}

afterEach(() => {
  if (insertedSessionIds.length > 0) {
    try {
      const db = getDB();
      for (const id of insertedSessionIds.splice(0)) {
        db.prepare(`DELETE FROM session_text WHERE session_id = ?`).run(id);
        db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
      }
    } catch {
    }
  }

  delete process.env.AGENTS_REAL_HOME;
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('switchConfigSymlink — rewrites session file_paths after backup rename (#136)', () => {
  let home: string;
  let claudeConfigDir: string;
  let versionHome: string;
  let sessionId: string;
  let oldSessionPath: string;

  beforeEach(() => {
    home = makeTempHome();
    claudeConfigDir = path.join(home, '.claude');
    versionHome = path.join(TEST_VERSIONS_DIR, 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });

    const projectsDir = path.join(claudeConfigDir, 'projects', '-Users-test-repo');
    fs.mkdirSync(projectsDir, { recursive: true });
    sessionId = `9c1f${Math.random().toString(16).slice(2, 10)}-test-${Date.now()}`;
    oldSessionPath = path.join(projectsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      oldSessionPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );

    const db = getDB();
    db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, short_id, agent, timestamp, file_path, is_team_origin)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(
      sessionId,
      sessionId.slice(0, 8),
      'claude',
      new Date().toISOString(),
      oldSessionPath,
    );
    insertedSessionIds.push(sessionId);
  });

  it('moves JSONLs to backup and rewrites DB rows so querySessions returns no phantom paths', async () => {
    const result = await switchConfigSymlink('claude', '2.0.65');
    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();

    const stat = fs.lstatSync(claudeConfigDir);
    expect(stat.isSymbolicLink()).toBe(true);

    const expectedNewPath = path.join(
      result.backupPath!,
      'projects',
      '-Users-test-repo',
      `${sessionId}.jsonl`,
    );
    expect(fs.existsSync(expectedNewPath)).toBe(true);

    const db = getDB();
    const row = db
      .prepare(`SELECT file_path FROM sessions WHERE id = ?`)
      .get(sessionId) as { file_path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.file_path).toBe(expectedNewPath);
    expect(fs.existsSync(row!.file_path)).toBe(true);

    const sessions = querySessions({ limit: 5000 });
    const hit = sessions.find(s => s.id === sessionId);
    expect(hit).toBeDefined();
    expect(hit!.filePath).toBe(expectedNewPath);
  });

  it('querySessions filters out rows whose JSONL has vanished (defensive)', () => {
    const db = getDB();
    const ghostPath = path.join(home, 'ghost', `${sessionId}.jsonl`);
    db.prepare(`UPDATE sessions SET file_path = ? WHERE id = ?`).run(ghostPath, sessionId);
    expect(fs.existsSync(ghostPath)).toBe(false);

    const sessions = querySessions({ limit: 5000 });
    const hit = sessions.find(s => s.id === sessionId);
    expect(hit).toBeUndefined();
  });
});
