/**
 * Attachment transport for `agents run --attach <file>` (PHNX-3999 F21).
 *
 * An attachment is a LOCAL file the operator hands to a run — an AGI Menu video
 * capture, a log, a screenshot. The agent that consumes it may be executing on
 * another machine, so a path alone is worthless: the bytes have to land on the
 * box that actually runs the harness, and the prompt must name the path as that
 * box sees it. Everything here exists to make that one guarantee true:
 *
 *   validate locally  ->  place the run  ->  stage on the EXECUTION host
 *                     ->  verify the bytes there  ->  embed worker-local paths
 *
 * Ordering is the contract. {@link validateAttachments} runs before placement so
 * a typo'd path costs nothing; staging runs inside the dispatch path, after
 * `--device auto` has already collapsed to a concrete host (`smart-launch.ts`
 * `applyDeviceAutoToOptions`), so the bytes can never land on a box other than
 * the one the run lands on. A staging failure throws before launch — there is no
 * state in which a task is running against a half-transferred attachment.
 *
 * Layout, identical local and remote:
 *
 *     <cache>/hosts/<id>.attachments/<1..N>/<original basename>
 *
 * One numbered subdir per attachment. That is what makes literal spaces, quotes,
 * Unicode and duplicate basenames survive byte-exact: nothing is ever renamed or
 * escaped into a flat namespace, and the only path segment we synthesize (`<id>`,
 * `<n>`) is plain ASCII, so the destination we hand `scp` and the remote shell
 * needs no quoting gymnastics while the filename itself rides the transfer
 * protocol rather than a command line.
 *
 * Lifecycle rides the existing run artifacts (`hosts/tasks.ts`): the staging dir
 * is a sibling of the dispatch's `<id>.log`/`<id>.exit` under the host's
 * `~/.agents/.cache/hosts/`, is recorded on the task record as
 * `remoteAttachDir`, and is removed by the same terminate/stop teardown. Anything
 * orphaned by a crash is swept by the age prune this module runs at stage time,
 * so staging cannot grow without bound.
 *
 * This path carries operator-chosen files only. It is never a credential
 * transport: `hosts/credentials.ts` owns that question and refuses it.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256File } from '../sha256-asset.js';
import { formatBytes } from '../format.js';
import { shellQuote, sshExec, sshConnectOpts, controlOpts } from '../ssh-exec.js';
import { hostsCacheDir } from './tasks.js';
import type { Host } from './types.js';
import { hostIdentityArgs } from './types.js';
import { remoteShellFor } from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';

/**
 * Anything an operator can fix by editing their command line. The message is
 * final user-facing copy — callers print it verbatim and exit non-zero rather
 * than wrapping it in another sentence.
 */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** A local file that passed validation and knows its own bytes. */
export interface ResolvedAttachment {
  /** The `--attach` value exactly as typed, for error messages. */
  input: string;
  /**
   * Absolute, symlink-RESOLVED path on the machine that parsed the flag. Resolved
   * because `link(2)` does not dereference: hardlinking a symlink would stage a
   * dangling pointer back at the operator's tree rather than the file's bytes.
   */
  localPath: string;
  /**
   * Basename the operator pointed AT, preserved byte-exact — spaces, quotes and
   * Unicode included. Taken before symlink resolution, so attaching
   * `~/latest.mov` shows the agent `latest.mov` rather than the dated real name.
   */
  name: string;
  bytes: number;
  /** Hex sha256 of the local bytes, checked again at the destination. */
  sha256: string;
}

/** Attachments as they exist on the machine that will run the agent. */
export interface StagedAttachments {
  /** Absolute staging root on the execution host — the `--add-dir` grant. */
  dir: string;
  /** True when the bytes crossed an SSH hop to get here. */
  remote: boolean;
  /** Input order preserved; `path` is absolute on the execution host. */
  files: Array<ResolvedAttachment & { path: string }>;
}

/**
 * Refuse a file this large rather than discover the problem mid-transfer. The
 * ceiling is about failing early and predictably, not about a protocol limit —
 * a multi-GB attachment is a mistake (a whole directory, a disk image) far more
 * often than an intent, and the operator gets to say so explicitly by splitting it.
 */
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

/** Age at which an orphaned staging dir is swept. Long enough that a followed run never races it. */
const STAGING_PRUNE_DAYS = 7;

/**
 * A basename that survives the transfer must also survive being quoted into the
 * verification script and read back out of its line-oriented output. Control
 * characters (a newline above all) break both, so they are rejected up front
 * instead of corrupting a check that would then pass by accident.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Validate every `--attach` path and hash its bytes.
 *
 * Call this BEFORE placement and before any task starts: it is the only chance
 * to tell an operator "that file does not exist" without having already picked a
 * device, opened an SSH connection, or spent a token. Every rejection is a hard
 * throw — a file that cannot be attached never degrades into a run without it.
 *
 * The hash computed here is the reference the destination is checked against, so
 * it is taken from the same bytes that will be transferred rather than trusted
 * from a stat.
 */
export async function validateAttachments(inputs: string[]): Promise<ResolvedAttachment[]> {
  const resolved: ResolvedAttachment[] = [];
  for (const input of inputs) {
    const expanded = input.startsWith('~/') || input === '~'
      ? path.join(os.homedir(), input.slice(1))
      : input;
    const abs = path.resolve(expanded);

    let stat: fs.Stats;
    let real: string;
    try {
      // statSync follows symlinks: a link to a real file is a legitimate
      // attachment, a dangling one lands here as ENOENT like any missing path.
      stat = fs.statSync(abs);
      real = fs.realpathSync(abs);
    } catch {
      throw new AttachmentError(`--attach ${input}: no such file (${abs}).`);
    }
    if (stat.isDirectory()) {
      throw new AttachmentError(`--attach ${input}: is a directory. Attach files individually, or pass the directory with --add-dir.`);
    }
    if (!stat.isFile()) {
      throw new AttachmentError(`--attach ${input}: not a regular file (${abs}).`);
    }
    if (stat.size === 0) {
      throw new AttachmentError(`--attach ${input}: file is empty (0 bytes).`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `--attach ${input}: ${formatBytes(stat.size)} exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} attachment limit.`,
      );
    }
    try {
      fs.accessSync(abs, fs.constants.R_OK);
    } catch {
      throw new AttachmentError(`--attach ${input}: not readable (${abs}).`);
    }
    // From the path the operator typed, not the realpath — see `name` above.
    const name = path.basename(abs);
    if (CONTROL_CHARS_RE.test(name)) {
      throw new AttachmentError(`--attach ${input}: the filename contains a control character, which cannot be transferred safely. Rename the file.`);
    }

    resolved.push({ input, localPath: real, name, bytes: stat.size, sha256: await sha256File(real) });
  }
  return resolved;
}

/** The staging root for one run: a sibling of that run's `<id>.log` / `<id>.exit`. */
function stagingDirName(id: string): string {
  return `${id}.attachments`;
}

/** Per-attachment subdir, 1-indexed in the operator's `--attach` order. */
function slotOf(dir: string, index: number, name: string): string {
  return `${dir}/${index + 1}/${name}`;
}

/**
 * Sweep staging dirs older than {@link STAGING_PRUNE_DAYS} out of the hosts
 * cache. Orphans only exist when a process died between staging and teardown, so
 * this is a backstop for the normal lifecycle (terminate/stop removes the dir),
 * not the primary reclaim — it is best-effort and never fails a run.
 */
function pruneStaleLocalStaging(root: string, now = Date.now()): void {
  const cutoff = now - STAGING_PRUNE_DAYS * 24 * 60 * 60 * 1000;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.attachments')) continue;
    const dir = path.join(root, entry.name);
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a dir we cannot stat or remove is left for the next sweep */
    }
  }
}

/**
 * Stage attachments for a run executing on THIS machine — the no-device case and
 * the same-host fallback where `--device auto` resolved to the local box.
 *
 * No network, by construction, and the same guarantee as the remote path: every
 * file is copied into its slot and then re-verified AT THE DESTINATION — size,
 * sha256, readability — before the run is allowed to start.
 *
 * Copied, not hardlinked, even though a link would be free. A hardlink shares an
 * inode, so an in-place rewrite of the operator's original would change the
 * attachment after it was verified, and "every attachment verified before the
 * task starts" would mean nothing. The staged tree is a snapshot; a large video
 * costs a copy, and that is the price of the guarantee.
 */
export async function stageAttachmentsLocally(attachments: ResolvedAttachment[]): Promise<StagedAttachments> {
  const root = hostsCacheDir();
  fs.mkdirSync(root, { recursive: true });
  pruneStaleLocalStaging(root);

  const dir = path.join(root, stagingDirName(randomUUID().slice(0, 8)));
  const files: Array<ResolvedAttachment & { path: string }> = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      const slot = path.join(dir, String(index + 1));
      fs.mkdirSync(slot, { recursive: true });
      const dest = path.join(slot, attachment.name);
      try {
        fs.copyFileSync(attachment.localPath, dest);
      } catch (err) {
        throw new AttachmentError(`--attach ${attachment.input}: could not be staged — ${(err as Error).message}`);
      }
      await verifyStagedFile(attachment, dest, 'this machine');
      files.push({ ...attachment, path: dest });
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, remote: false, files };
}

/**
 * Prove one staged file matches what was validated. Same three checks the remote
 * host runs on its own copy, so a local run is held to the identical bar: a
 * source swapped for a same-length file between validation and staging is caught
 * by the digest, not waved through by the byte count.
 */
async function verifyStagedFile(attachment: ResolvedAttachment, dest: string, where: string): Promise<void> {
  try {
    fs.accessSync(dest, fs.constants.R_OK);
  } catch {
    throw new AttachmentError(`--attach ${attachment.input}: the staged copy is not readable at ${dest}.`);
  }
  const bytes = fs.statSync(dest).size;
  const digest = await sha256File(dest);
  if (bytes !== attachment.bytes || digest !== attachment.sha256) {
    throw new AttachmentError(
      `--attach ${attachment.input}: the copy on ${where} does not match the file that was validated ` +
      `(${bytes} bytes / ${digest.slice(0, 12)}… vs ${attachment.bytes} bytes / ${attachment.sha256.slice(0, 12)}…). ` +
      `The source changed while the run was starting.`,
    );
  }
}

/** The POSIX shell script that creates a run's staging slots and reports the absolute root. */
export function buildStagingSetupScript(id: string, count: number): string {
  const slots = Array.from({ length: count }, (_, i) => `"$d/${i + 1}"`).join(' ');
  return [
    'set -e',
    'root="$HOME/.agents/.cache/hosts"',
    'mkdir -p "$root"',
    // Backstop sweep for dirs an interrupted run never tore down (see pruneStaleLocalStaging).
    `find "$root" -maxdepth 1 -type d -name '*.attachments' -mtime +${STAGING_PRUNE_DAYS} -exec rm -rf {} + 2>/dev/null || true`,
    `d="$root/${stagingDirName(id)}"`,
    `mkdir -p ${slots}`,
    'printf %s\\\\n "$d"',
  ].join('\n');
}

/**
 * The POSIX shell script that proves each attachment arrived intact.
 *
 * Prints `<index> <bytes> <sha256>` per file. A host with neither `sha256sum`
 * nor `shasum` exits non-zero rather than printing an unverified line — an
 * attachment we cannot check is a failed transfer, not a passed one.
 */
export function buildStagingVerifyScript(dir: string, names: string[]): string {
  const lines = [
    'set -u',
    // Hash from STDIN, never by filename argument: GNU coreutils prefixes its
    // line with a backslash and escapes the name whenever it contains `\\` or a
    // newline, which would put a 65th character in front of the digest. Reading
    // stdin prints `<hash>  -` for every name there is.
    'hash_of() {',
    '  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d" " -f1;',
    '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d" " -f1;',
    '  else echo "no sha256sum or shasum on this host" >&2; exit 3; fi',
    '}',
  ];
  names.forEach((name, index) => {
    const slot = shellQuote(slotOf(dir, index, name));
    lines.push(
      `p=${slot}`,
      `[ -f "$p" ] || { echo "missing after transfer: $p" >&2; exit 4; }`,
      `[ -r "$p" ] || { echo "not readable after transfer: $p" >&2; exit 5; }`,
      `printf '%s %s %s\\n' ${index + 1} "$(wc -c < "$p" | tr -d " ")" "$(hash_of "$p")"`,
    );
  });
  return lines.join('\n');
}

/** Parse the verify script's `<index> <bytes> <sha256>` lines, keyed by 1-based index. */
export function parseStagingVerifyOutput(stdout: string): Map<number, { bytes: number; sha256: string }> {
  const rows = new Map<number, { bytes: number; sha256: string }>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+) (\d+) ([A-Fa-f0-9]{64})$/);
    if (m) rows.set(Number(m[1]), { bytes: Number(m[2]), sha256: m[3].toLowerCase() });
  }
  return rows;
}

interface RemoteStagingOptions {
  /**
   * The SSH target for `host`. Passed in rather than re-derived because the
   * dispatch path has already computed it (`sshTargetFor`) and the two must not
   * be able to disagree about which box is being written to.
   */
  target: string;
}

function sshFailure(host: Host, what: string, res: { code: number | null; stdout: string; stderr: string }): AttachmentError {
  const detail = (res.stderr || res.stdout).trim() || (res.code === null ? 'ssh error' : `exit ${res.code}`);
  return new AttachmentError(`Failed to ${what} on "${host.name}": ${detail}`);
}

/**
 * Copy one file into its slot with `scp`.
 *
 * The destination is the SLOT DIRECTORY, never the full file path: a directory
 * target makes scp carry the basename inside the transfer protocol, so a name
 * with spaces or quotes is never re-parsed by the remote shell. Our slot paths
 * are synthesized ASCII, so the one string that does reach that shell is inert.
 * The path is home-relative for the same reason — no `$HOME` to expand, and it
 * resolves identically under scp's legacy and SFTP modes.
 */
function scpIntoSlot(localPath: string, target: string, remoteSlot: string, identityArgs: string[]): { code: number | null; stdout: string; stderr: string } {
  const args = [
    ...identityArgs,
    ...sshConnectOpts(controlOpts()),
    '-q',
    localPath,
    `${target}:${remoteSlot}/`,
  ];
  const res = spawnSync('scp', args, { encoding: 'utf-8', timeout: 30 * 60 * 1000 });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? res.error.message : '') };
}

/**
 * Stage attachments on the host a run is about to execute on, and prove they
 * arrived.
 *
 * Called from the dispatch path with the ALREADY-RESOLVED host, which is what
 * ties the bytes to the machine that runs the agent: placement happens once, up
 * the stack, and this function never re-resolves it. Three round trips — create
 * the slots and learn the remote `$HOME`, copy, verify — and a failure at any of
 * them removes the staging dir and throws, so a task is never launched against a
 * partial transfer.
 */
export async function stageAttachmentsOnHost(
  host: Host,
  attachments: ResolvedAttachment[],
  opts: RemoteStagingOptions,
): Promise<StagedAttachments> {
  if (remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)) !== 'posix') {
    throw new AttachmentError(
      `--attach cannot target "${host.name}": attachment staging speaks the POSIX shell protocol and this host is Windows. ` +
      `Run it on a POSIX device, or attach the files to a local run.`,
    );
  }

  // Its own 8-hex id, in the same directory as the run's `<id>.log`/`<id>.exit`.
  // Not the dispatch id: that is minted later, inside the launch, and the bytes
  // have to be on the host before the argv naming them can be built.
  const id = randomUUID().slice(0, 8);
  const identityArgs = hostIdentityArgs(host);
  const setup = sshExec(opts.target, buildStagingSetupScript(id, attachments.length), {
    timeoutMs: 30_000,
    multiplex: true,
    extraSshArgs: identityArgs,
  });
  if (setup.code !== 0) throw sshFailure(host, 'create the attachment staging directory', setup);
  const dir = setup.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!dir.startsWith('/')) {
    throw new AttachmentError(`Failed to resolve the attachment staging directory on "${host.name}": got ${JSON.stringify(dir)}.`);
  }
  // Home-relative twin of `dir`, for scp (see scpIntoSlot).
  const relDir = `.agents/.cache/hosts/${stagingDirName(id)}`;

  try {
    attachments.forEach((attachment, index) => {
      const res = scpIntoSlot(attachment.localPath, opts.target, `${relDir}/${index + 1}`, identityArgs);
      if (res.code !== 0) throw sshFailure(host, `copy ${attachment.input}`, res);
    });

    const verify = sshExec(opts.target, buildStagingVerifyScript(dir, attachments.map((a) => a.name)), {
      timeoutMs: 10 * 60 * 1000,
      multiplex: true,
      extraSshArgs: identityArgs,
    });
    if (verify.code !== 0) throw sshFailure(host, 'verify the attachments', verify);
    const rows = parseStagingVerifyOutput(verify.stdout);

    const files = attachments.map((attachment, index) => {
      const row = rows.get(index + 1);
      if (!row) {
        throw new AttachmentError(`--attach ${attachment.input}: "${host.name}" reported nothing for this file after transfer.`);
      }
      if (row.bytes !== attachment.bytes || row.sha256 !== attachment.sha256) {
        throw new AttachmentError(
          `--attach ${attachment.input}: the copy on "${host.name}" does not match the local file ` +
          `(${row.bytes} bytes / ${row.sha256.slice(0, 12)}… vs ${attachment.bytes} bytes / ${attachment.sha256.slice(0, 12)}…). The transfer was incomplete.`,
        );
      }
      return { ...attachment, path: slotOf(dir, index, attachment.name) };
    });

    return { dir, remote: true, files };
  } catch (err) {
    removeRemoteStaging(opts.target, dir, identityArgs);
    throw err;
  }
}

/**
 * Remove a remote staging dir. Best-effort: it runs on the failure path (where a
 * throw is already on its way) and on teardown (where the run's own log removal
 * is the caller's real job), so a host that has gone away must not turn either
 * into a second error. The age prune reclaims whatever this misses.
 */
export function removeRemoteStaging(target: string, dir: string, identityArgs: string[] = []): void {
  if (!dir.startsWith('/') || !dir.endsWith('.attachments')) return;
  try {
    sshExec(target, `rm -rf ${shellQuote(dir)}`, { timeoutMs: 15_000, multiplex: true, extraSshArgs: identityArgs });
  } catch {
    /* see doc comment */
  }
}

/**
 * The block appended to the prompt.
 *
 * It names EXECUTION-HOST paths and nothing else — the operator's original
 * location is deliberately absent, because on a remote run it does not exist and
 * an agent that sees it will try to read it. Paths are listed one per line with
 * their size so the agent can tell a 4 KB log from a 90 MB capture before opening it.
 */
export function attachmentPromptSection(staged: StagedAttachments): string {
  if (staged.files.length === 0) return '';
  const lines = staged.files.map((f) => `${f.path} (${formatBytes(f.bytes)})`);
  return `\n\nAttached files, already present on this machine at these exact paths:\n${lines.join('\n')}`;
}

/**
 * The `--add-dir` grants an attached run needs: the staging root, once. Per-file
 * grants would be the same access spelled N times, and the harness flag already
 * covers a tree.
 */
export function attachmentAddDirs(staged: StagedAttachments): string[] {
  return staged.files.length === 0 ? [] : [staged.dir];
}
