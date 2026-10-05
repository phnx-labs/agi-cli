import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolated HOME so SQLite contents are fully controlled: scan-coverage vs usage-coverage is
// asserted against a known total that a shared db (resource-stats.test.ts) would perturb. Real
// SQLite, no mocks (PHNX-2301).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-rescov-'));
process.env.HOME = TEST_HOME;

const { getDB, resourceUsageCoverage, backfillResourceUsage } = await import('../db.js');

const SEED_FILES_DIR = path.join(TEST_HOME, 'seed-files');
fs.mkdirSync(SEED_FILES_DIR, { recursive: true });

function seedSession(id: string, filePath: string): void {
  getDB().prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd, machine,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, 'claude', NULL, '2026-06-01T00:00:00.000Z', 'proj', ?, 'boxA', ?, 0, 0, 0, 0)
  `).run(id, id.slice(0, 8), SEED_FILES_DIR, filePath);
}

/** A claude transcript that explicitly invokes one skill + one slash command. */
function invokingTranscript(): string {
  return [
    { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'run the teams skill' } },
    { type: 'assistant', timestamp: '2026-06-28T00:00:10.000Z', uuid: 'a-1', message: { id: 'm1', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sk-1', name: 'Skill', input: { skill: 'teams' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
    { type: 'assistant', timestamp: '2026-06-28T00:00:20.000Z', uuid: 'a-2', message: { id: 'm2', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sc-1', name: 'SlashCommand', input: { command: '/recap' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** A real, complete claude transcript with turns but NO skill/slash-command — the
 * "we scanned it and it genuinely invoked nothing" case that must count as SCANNED
 * yet contribute nothing to the with-usage count. */
function quietTranscript(): string {
  return [
    { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'what does this function do?' } },
    { type: 'assistant', timestamp: '2026-06-28T00:00:10.000Z', uuid: 'q-1', message: { id: 'q1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'It sums the array.' }], usage: { input_tokens: 5, output_tokens: 5 } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

// 5 sessions, all with real non-empty transcripts: 2 invoke a resource, 3 are
// quiet. A full backfill scans all 5 (ledger stamped for every one, incl. the
// quiet zero-usage ones), but only 2 land a session_resource_usage row.
beforeAll(() => {
  for (const id of ['inv1', 'inv2']) {
    const fp = path.join(SEED_FILES_DIR, `${id}.jsonl`);
    fs.writeFileSync(fp, invokingTranscript());
    seedSession(id, fp);
  }
  for (const id of ['quiet1', 'quiet2', 'quiet3']) {
    const fp = path.join(SEED_FILES_DIR, `${id}.jsonl`);
    fs.writeFileSync(fp, quietTranscript());
    seedSession(id, fp);
  }
});

describe('resourceUsageCoverage — scan coverage is distinct from with-usage coverage (PHNX-2301)', () => {
  it('before backfill: nothing scanned, and the old with-usage numerator is 0 — both would nag', () => {
    const cov = resourceUsageCoverage();
    expect(cov.total).toBe(5);
    expect(cov.scanned).toBe(0);   // no ledger rows yet → backfill hasn't run
    expect(cov.covered).toBe(0);   // no usage rows written yet
  });

  it('after backfill: scan coverage reaches 100% while with-usage stays sparse — the exact 1.2% illusion', () => {
    const result = backfillResourceUsage({});
    // Every one of the 5 real transcripts is parsed and its ledger stamped —
    // including the 3 quiet sessions that produced zero usage rows.
    expect(result.scanned).toBe(5);
    expect(result.updated).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.resourceRows).toBe(4); // inv1 + inv2, each a skill + a command

    const cov = resourceUsageCoverage();
    // The fix: scan coverage is the honest "backfill has run" signal — 5/5, so the
    // hint (`scanned/total < 0.5`) clears. The OLD covered-based coverage would read
    // 2/5 = 40% and keep nagging for a backfill that has, in fact, fully run.
    expect(cov.scanned).toBe(5);
    expect(cov.total).toBe(5);
    expect(cov.scanned / cov.total).toBe(1);           // hint cleared — healthy path
    expect(cov.covered).toBe(2);                       // absolute signal count, unchanged meaning
    expect(cov.covered / cov.total).toBeLessThan(0.5); // old numerator would still nag
  });

  it('a stale-extractor-version ledger row does NOT count as scanned (re-derived next backfill)', () => {
    // Demote inv1's ledger row to an older extractor version, as a pre-bump row
    // would read. It must drop out of the scanned count until re-derived.
    getDB().prepare(`UPDATE resource_scan_ledger SET extractor_version = 0 WHERE session_id = 'inv1'`).run();
    expect(resourceUsageCoverage().scanned).toBe(4);
    // Restore so the row is current again.
    getDB().prepare(`UPDATE resource_scan_ledger SET extractor_version = 1 WHERE session_id = 'inv1'`).run();
    expect(resourceUsageCoverage().scanned).toBe(5);
  });

  it('a ledger row for a since-vanished session does NOT inflate scan coverage past the indexed set', () => {
    // A ledger row whose session was dropped from `sessions` (transcript vanished)
    // must not be counted — the JOIN guards this. Insert an orphan ledger row.
    getDB().prepare(`
      INSERT INTO resource_scan_ledger
        (session_id, file_path, file_mtime_ms, file_size, extractor_version, indexed_at, resource_count)
      VALUES ('ghost', ?, 0, 0, 1, 0, 0)
    `).run(path.join(SEED_FILES_DIR, 'ghost.jsonl'));
    const cov = resourceUsageCoverage();
    expect(cov.scanned).toBe(5); // ghost excluded — no matching sessions row
    expect(cov.total).toBe(5);
  });
});
