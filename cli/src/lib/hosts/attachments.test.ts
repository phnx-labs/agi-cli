import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `hostsCacheDir()` derives from state.js's base dir, which is frozen at module
// LOAD time from `process.env.HOME`. Static imports hoist above a plain
// assignment, so set HOME first and pull the modules in with a top-level
// `await import` — the same hermetic pattern as session-index.test.ts.
//
// The prefix is terse on purpose: the real-peer test below opens a multiplexed
// ssh connection, whose control socket lives under this HOME
// (`ssh-exec.ts` `controlOpts`) and must fit the ~108-byte `sun_path` limit
// once ssh has appended its own %C hash and temp suffix.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-'));
process.env.HOME = TEST_HOME;

const {
  AttachmentError,
  validateAttachments,
  stageAttachmentsLocally,
  attachmentPromptSection,
  attachmentAddDirs,
  buildStagingSetupScript,
  buildStagingVerifyScript,
  parseStagingVerifyOutput,
} = await import('./attachments.js');
const { hostsCacheDir } = await import('./tasks.js');

const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-fix-'));

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

/** Write a real file with the given basename and return its absolute path. */
function fixture(name: string, body: string | Buffer, dir = FIXTURES): string {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}

function sha256(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Run one of the generated remote scripts under a real bash, as the host would. */
function runScript(script: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf-8', env: { ...process.env, HOME: home } });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('validateAttachments', () => {
  it('accepts a real file and hashes the bytes that will be transferred', async () => {
    const body = 'capture bytes\n';
    const file = fixture('clip.mp4', body);
    const [attachment] = await validateAttachments([file]);
    expect(attachment).toMatchObject({ input: file, localPath: file, name: 'clip.mp4', bytes: body.length });
    expect(attachment.sha256).toBe(sha256(body));
  });

  it('preserves a basename with spaces, quotes and Unicode byte-exact', async () => {
    const name = `déjà vu 'quoted' "double".mov`;
    const file = fixture(name, 'x');
    const [attachment] = await validateAttachments([file]);
    expect(attachment.name).toBe(name);
  });

  it('expands a leading ~ against the home directory', async () => {
    const file = fixture('tilde.txt', 'home relative', TEST_HOME);
    const [attachment] = await validateAttachments(['~/tilde.txt']);
    expect(attachment.localPath).toBe(file);
  });

  it('rejects a missing path before anything is staged', async () => {
    await expect(validateAttachments([path.join(FIXTURES, 'nope.mp4')])).rejects.toBeInstanceOf(AttachmentError);
  });

  it('rejects a directory with a steer to --add-dir', async () => {
    await expect(validateAttachments([FIXTURES])).rejects.toThrow(/is a directory.*--add-dir/s);
  });

  it('rejects a dangling symlink as a missing file', async () => {
    const link = path.join(FIXTURES, 'dangling.lnk');
    fs.symlinkSync(path.join(FIXTURES, 'absent-target'), link);
    await expect(validateAttachments([link])).rejects.toThrow(/no such file/);
  });

  it('resolves a symlink to its target but keeps the name the operator typed', async () => {
    const real = fixture('recording-2026-09-13.mov', 'linked');
    const link = path.join(FIXTURES, 'latest.mov');
    fs.symlinkSync(real, link);
    const [attachment] = await validateAttachments([link]);
    expect(attachment.sha256).toBe(sha256('linked'));
    // The bytes come from the target — a hardlink to the link itself would
    // stage a pointer back into the operator's tree, not the file.
    expect(attachment.localPath).toBe(real);
    expect(attachment.name).toBe('latest.mov');
  });

  it('rejects an empty file', async () => {
    await expect(validateAttachments([fixture('empty.bin', '')])).rejects.toThrow(/empty/);
  });

  it('rejects an unreadable file', async () => {
    const file = fixture('locked.txt', 'secret');
    fs.chmodSync(file, 0o000);
    try {
      // Root bypasses the permission bit entirely, so this can only be asserted
      // as an unprivileged user; skipping is honest where it cannot be exercised.
      if (process.getuid?.() === 0) return;
      await expect(validateAttachments([file])).rejects.toThrow(/not readable/);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it('rejects a filename carrying a control character', async () => {
    const file = fixture('newline\nname.txt', 'x');
    await expect(validateAttachments([file])).rejects.toThrow(/control character/);
  });

  it('rejects the whole set as soon as one path is bad, before hashing the rest', async () => {
    const good = fixture('good-one.txt', 'ok');
    await expect(validateAttachments([good, path.join(FIXTURES, 'absent.txt')])).rejects.toBeInstanceOf(AttachmentError);
  });
});

describe('stageAttachmentsLocally', () => {
  it('keeps duplicate basenames distinct and byte-exact, with no renaming', async () => {
    const a = fixture('report.pdf', 'first copy', path.join(FIXTURES, 'dir-a'));
    const b = fixture('report.pdf', 'second copy', path.join(FIXTURES, 'dir-b'));
    const staged = await stageAttachmentsLocally(await validateAttachments([a, b]));

    expect(staged.remote).toBe(false);
    expect(staged.files.map((f) => path.basename(f.path))).toEqual(['report.pdf', 'report.pdf']);
    expect(path.dirname(staged.files[0].path)).not.toBe(path.dirname(staged.files[1].path));
    expect(fs.readFileSync(staged.files[0].path, 'utf-8')).toBe('first copy');
    expect(fs.readFileSync(staged.files[1].path, 'utf-8')).toBe('second copy');
  });

  it('preserves spaces, quotes and Unicode in the staged path', async () => {
    const name = `déjà vu 'quoted' "double".mov`;
    const staged = await stageAttachmentsLocally(await validateAttachments([fixture(name, 'unicode body')]));
    expect(path.basename(staged.files[0].path)).toBe(name);
    expect(fs.readFileSync(staged.files[0].path, 'utf-8')).toBe('unicode body');
  });

  it('stages inside the run-artifact tree as an independent snapshot', async () => {
    const file = fixture('big.bin', Buffer.alloc(4096, 7));
    const staged = await stageAttachmentsLocally(await validateAttachments([file]));

    expect(staged.dir.startsWith(hostsCacheDir())).toBe(true);
    expect(path.basename(staged.dir).endsWith('.attachments')).toBe(true);
    // A distinct inode is the guarantee: an in-place rewrite of the operator's
    // original cannot change an attachment that was already verified.
    expect(fs.statSync(staged.files[0].path).ino).not.toBe(fs.statSync(file).ino);
    fs.writeFileSync(file, Buffer.alloc(4096, 9));
    expect(fs.readFileSync(staged.files[0].path)).toEqual(Buffer.alloc(4096, 7));
  });

  it('stages a symlinked attachment by its target bytes, under the typed name', async () => {
    const real = fixture('dated-clip.mov', 'target bytes', path.join(FIXTURES, 'sym'));
    const link = path.join(FIXTURES, 'sym', 'newest.mov');
    fs.symlinkSync(real, link);

    const staged = await stageAttachmentsLocally(await validateAttachments([link]));

    expect(path.basename(staged.files[0].path)).toBe('newest.mov');
    expect(fs.lstatSync(staged.files[0].path).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(staged.files[0].path, 'utf-8')).toBe('target bytes');
  });

  it('rejects a source swapped for a same-size file between validation and staging', async () => {
    const file = fixture('swapped.txt', 'AAAAAAAAAA');
    const resolved = await validateAttachments([file]);
    fs.writeFileSync(file, 'BBBBBBBBBB'); // identical length, different bytes
    await expect(stageAttachmentsLocally(resolved)).rejects.toThrow(/does not match the file that was validated/);
  });

  it('removes the staging dir when one file cannot be staged', async () => {
    const file = fixture('vanishing.txt', 'here for now');
    const resolved = await validateAttachments([file]);
    fs.rmSync(file);
    const before = fs.readdirSync(hostsCacheDir()).filter((n) => n.endsWith('.attachments')).length;
    await expect(stageAttachmentsLocally(resolved)).rejects.toBeInstanceOf(AttachmentError);
    const after = fs.readdirSync(hostsCacheDir()).filter((n) => n.endsWith('.attachments')).length;
    expect(after).toBe(before);
  });

  it('sweeps a staging dir older than the prune window and keeps a fresh one', async () => {
    const stale = path.join(hostsCacheDir(), 'aaaaaaaa.attachments');
    fs.mkdirSync(path.join(stale, '1'), { recursive: true });
    fs.writeFileSync(path.join(stale, '1', 'old.txt'), 'old');
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, longAgo, longAgo);

    const fresh = await stageAttachmentsLocally(await validateAttachments([fixture('kept.txt', 'kept')]));

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh.dir)).toBe(true);
  });
});

describe('the prompt block and access grant', () => {
  it('names only execution-host paths and grants the staging root once', async () => {
    const staged = await stageAttachmentsLocally(
      await validateAttachments([fixture('one.txt', 'a'), fixture('two.txt', 'bb')]),
    );
    const section = attachmentPromptSection(staged);

    for (const file of staged.files) expect(section).toContain(file.path);
    // The operator's own location must not ride along: on a remote run it does
    // not exist there, and an agent that sees it will try to read it.
    expect(section).not.toContain(FIXTURES);
    expect(attachmentAddDirs(staged)).toEqual([staged.dir]);
  });

  it('adds nothing at all when there are no attachments', () => {
    const empty = { dir: '/tmp/none.attachments', remote: false, files: [] };
    expect(attachmentPromptSection(empty)).toBe('');
    expect(attachmentAddDirs(empty)).toEqual([]);
  });
});

describe('the remote staging protocol, executed by a real shell', () => {
  it('creates one numbered slot per attachment and reports the absolute root', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-remote-'));
    const res = runScript(buildStagingSetupScript('abc12345', 3), home);

    expect(res.status).toBe(0);
    const dir = res.stdout.trim();
    expect(dir).toBe(path.join(home, '.agents/.cache/hosts/abc12345.attachments'));
    for (const slot of ['1', '2', '3']) expect(fs.existsSync(path.join(dir, slot))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sweeps stale staging dirs on the host as part of setup', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-remote-'));
    const root = path.join(home, '.agents/.cache/hosts');
    const stale = path.join(root, 'deadbeef.attachments');
    fs.mkdirSync(stale, { recursive: true });
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, longAgo, longAgo);

    expect(runScript(buildStagingSetupScript('feedface', 1), home).status).toBe(0);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(root, 'feedface.attachments/1'))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports the true size and sha256 of each staged file, including odd basenames', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-remote-'));
    const dir = path.join(home, 'staged');
    const names = [`déjà vu 'quoted' "double".mov`, 'report.pdf', 'report.pdf'];
    const bodies = ['unicode body', 'first copy', 'second copy'];
    names.forEach((name, i) => {
      fs.mkdirSync(path.join(dir, String(i + 1)), { recursive: true });
      fs.writeFileSync(path.join(dir, String(i + 1), name), bodies[i]);
    });

    const res = runScript(buildStagingVerifyScript(dir, names), home);
    expect(res.status).toBe(0);

    const rows = parseStagingVerifyOutput(res.stdout);
    names.forEach((_, i) => {
      expect(rows.get(i + 1)).toEqual({ bytes: bodies[i].length, sha256: sha256(bodies[i]) });
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('digests a filename containing a backslash, which coreutils would otherwise escape', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-remote-'));
    const dir = path.join(home, 'staged');
    const name = 'a\\b.mov';
    fs.mkdirSync(path.join(dir, '1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '1', name), 'backslash body');

    const res = runScript(buildStagingVerifyScript(dir, [name]), home);

    // `sha256sum <name>` would print `\\<hash>  a\\\\b.mov`; hashing stdin does not.
    expect(res.status).toBe(0);
    expect(parseStagingVerifyOutput(res.stdout).get(1)).toEqual({
      bytes: 'backslash body'.length,
      sha256: sha256('backslash body'),
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('exits non-zero when a file never arrived', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-remote-'));
    const dir = path.join(home, 'staged');
    fs.mkdirSync(path.join(dir, '1'), { recursive: true });

    const res = runScript(buildStagingVerifyScript(dir, ['absent.mp4']), home);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('missing after transfer');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports a truncated transfer as a hash mismatch the caller can catch', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-att-remote-'));
    const dir = path.join(home, 'staged');
    fs.mkdirSync(path.join(dir, '1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '1', 'clip.mp4'), 'half of th');

    const rows = parseStagingVerifyOutput(runScript(buildStagingVerifyScript(dir, ['clip.mp4']), home).stdout);

    expect(rows.get(1)!.sha256).not.toBe(sha256('half of the whole file'));
    expect(rows.get(1)!.bytes).toBe(10);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

/**
 * Real transfer to a real peer over real SSH. Opt-in like the Windows `--device`
 * e2e (`AGENTS_TEST_WIN_HOST`): CI has no second box, and a fabricated transport
 * would prove nothing this suite does not already prove locally.
 *
 * The value must be a target ssh can dial with NO configuration — `user@host`,
 * an IP, or a DNS name — not a fleet alias. `tests/setup.ts` deliberately pins
 * HOME to a sandbox so nothing in a fork can reach the real one, which means
 * `~/.ssh/config` (where the fleet aliases live) is not readable here. An alias
 * fails at connect for a reason that has nothing to do with the transport.
 *
 *   AGENTS_TEST_ATTACH_HOST=muqsit@100.82.16.108 bunx vitest run src/lib/hosts/attachments.test.ts
 */
const REMOTE_TARGET = process.env.AGENTS_TEST_ATTACH_HOST;
describe.skipIf(!REMOTE_TARGET)('stageAttachmentsOnHost against a real peer', () => {
  it('lands every byte on the peer and returns peer-local paths', async () => {
    const { stageAttachmentsOnHost, removeRemoteStaging } = await import('./attachments.js');
    const target = REMOTE_TARGET!;
    const host = { name: target, provider: 'local', status: 'online', dispatchable: true } as never;

    const names = [`déjà vu 'quoted' "double".mov`, 'report.pdf', 'report.pdf'];
    const bodies = ['unicode body', 'first copy', 'second copy'];
    const sources = names.map((name, i) => fixture(name, bodies[i], path.join(FIXTURES, `remote-${i}`)));

    const staged = await stageAttachmentsOnHost(host, await validateAttachments(sources), { target });
    try {
      expect(staged.remote).toBe(true);
      expect(staged.dir).toMatch(/\/\.agents\/\.cache\/hosts\/[0-9a-f]{8}\.attachments$/);
      staged.files.forEach((file, i) => {
        expect(path.basename(file.path)).toBe(names[i]);
        // Ask the PEER, not our own bookkeeping, what actually landed there.
        const remote = execFileSync('ssh', [target, `sha256sum -- ${JSON.stringify(file.path)}`], { encoding: 'utf-8' });
        expect(remote.trim().split(/\s+/)[0]).toBe(sha256(bodies[i]));
      });
    } finally {
      removeRemoteStaging(target, staged.dir);
    }
    // Teardown really removed it — staging does not accumulate on the worker.
    const listing = spawnSync('ssh', [target, `ls -d -- ${JSON.stringify(staged.dir)}`], { encoding: 'utf-8' });
    expect(listing.status).not.toBe(0);
  }, 120_000);

  it('fails before dispatch when a file vanishes between validation and transfer', async () => {
    const { stageAttachmentsOnHost, AttachmentError: Err } = await import('./attachments.js');
    const target = REMOTE_TARGET!;
    const host = { name: target, provider: 'local', status: 'online', dispatchable: true } as never;

    const file = fixture('gone-before-transfer.txt', 'here for now', path.join(FIXTURES, 'vanish'));
    const resolved = await validateAttachments([file]);
    fs.rmSync(file);

    await expect(stageAttachmentsOnHost(host, resolved, { target })).rejects.toBeInstanceOf(Err);
  }, 120_000);
});
