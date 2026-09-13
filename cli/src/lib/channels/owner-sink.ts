/**
 * Owner-delivery-sink reachability probe (RUSH-2262).
 *
 * The feed/notify owner-delivery lane (`agents notify`, `agents feed post
 * --level important` / `--blocked`) reaches the owner over the rush-backed owner
 * channel (iMessage via `rush message send`). That transport can only deliver
 * from a context that BOTH finds the `rush` CLI on PATH and can read its
 * keychain-bound session. So a headless Linux fleet box (no rush) or a non-GUI
 * SSH session on a mac (login keychain locked) structurally cannot escalate —
 * and the failure is silent until a block is filed, surfacing only as the
 * after-the-fact `owner failed: …` line. `agents doctor` had no signal for it,
 * which is exactly the gap RUSH-2258 / RUSH-2262 flagged.
 *
 * At runtime the owner-delivery lane no longer strands this failure: when local
 * delivery fails on a box that structurally cannot reach the owner,
 * `forwardOwnerNotifyToPeer` (owner-forward.ts) hands it to a capable macOS peer
 * over SSH (PHNX-3303). This finding still stands as a diagnostic — the forward
 * is best-effort and only lands when a reachable mac peer exists, so a box that
 * cannot deliver locally is worth surfacing regardless.
 *
 * This probes the SAME transport the lane uses, from the SAME context doctor runs
 * in, so `agents doctor` can fail loud when this box cannot reach the owner. It is
 * deliberately honest about context: `rush whoami` is what tells a real signed-in
 * session apart from a keychain that is present but unreadable HERE. The session
 * token is a keychain item, NOT `~/.rush/user.yaml` (RUSH-2262), so this never
 * reads that file — checking it is the mistake that made a signed-in box look
 * signed out.
 *
 * `agents notify --dry-run` is NOT this probe: it short-circuits before the
 * `which rush` preflight (`providers/rush.ts`), so it reports `ok:true` on a box
 * with no rush at all. Resolvability (does the envelope build?) and reachability
 * (can this box actually deliver?) are different questions; this answers the
 * second.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Meta } from '../types.js';
import { readOwnerDest } from './send.js';
import { RUSH_CHANNELS } from './providers/rush.js';

const execFileAsync = promisify(execFile);

/** Why the owner sink cannot deliver from this box. */
export type OwnerSinkReason =
  | 'rush-not-on-path' // rush-backed channel, but `rush` is not on this box's PATH
  | 'rush-signed-out'; // rush is present but has no usable session in this context

export interface OwnerSinkStatus {
  /** Owner delivery is configured for this fleet (humans.yaml / notify.owner).
   *  When false, no finding is emitted — an un-opted-in box is not "broken". */
  configured: boolean;
  /** This box can actually deliver an owner notification right now. */
  reachable: boolean;
  /** Resolved owner channel (e.g. `imessage`). */
  channel?: string;
  /** Resolved transport after `notify.transports` mapping (usually === channel). */
  transport?: string;
  /** Set only when `reachable` is false. */
  reason?: OwnerSinkReason;
}

async function rushOnPath(): Promise<boolean> {
  try {
    await execFileAsync('which', ['rush'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/** Signed-in state from `rush whoami`, read with THIS context's keychain access.
 *  'unknown' (a timeout or output we can't classify) is treated as reachable by
 *  the caller — a slow or unexpected probe must not cry wolf and paint a false
 *  critical. Only a definitive "not logged in" is reported as signed out. */
async function rushSignedIn(): Promise<'yes' | 'no' | 'unknown'> {
  const classify = (s: string): 'yes' | 'no' | 'unknown' => {
    const out = s.toLowerCase();
    if (/not (logged in|signed in)/.test(out)) return 'no';
    if (/logged in as|session:\s*valid/.test(out)) return 'yes';
    return 'unknown';
  };
  try {
    const { stdout, stderr } = await execFileAsync('rush', ['whoami'], { timeout: 5000 });
    return classify(`${stdout}\n${stderr}`);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) return 'unknown'; // timed out — do not conclude signed-out
    // A signed-out rush commonly exits non-zero; trust an explicit message only.
    return classify(`${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
}

/**
 * Probe whether THIS box can deliver an owner notification right now. Returns
 * `configured:false` (and the caller emits no finding) when the fleet has no
 * owner channel configured — an un-opted-in box is not broken. When configured,
 * reports whether the resolved transport can actually deliver from here.
 *
 * Only the concrete rush-backed failure the lane hits is reported as unreachable;
 * non-rush transports (desktop / mailbox / …) deliver locally and are treated as
 * reachable rather than probed, so this never invents a critical it cannot back.
 */
export async function probeOwnerSink(meta: Meta): Promise<OwnerSinkStatus> {
  const dest = readOwnerDest(meta);
  if (!dest) return { configured: false, reachable: false };
  const channel = dest.channel;
  const transport = meta.notify?.transports?.[channel] ?? channel;

  if ((RUSH_CHANNELS as readonly string[]).includes(transport)) {
    if (!(await rushOnPath())) {
      return { configured: true, reachable: false, channel, transport, reason: 'rush-not-on-path' };
    }
    if ((await rushSignedIn()) === 'no') {
      return { configured: true, reachable: false, channel, transport, reason: 'rush-signed-out' };
    }
    return { configured: true, reachable: true, channel, transport };
  }

  return { configured: true, reachable: true, channel, transport };
}
