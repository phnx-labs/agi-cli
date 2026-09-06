import { createHash, randomUUID } from 'node:crypto';
import { normalizeHost } from '../machine-id.js';
import type { SessionWatchEnvelope, SessionWatchRow } from './watch.js';

/** Device observations are not sessions: a launcher may observe a peer's run.
 * Keep those observations separately and publish execution-owned state once. */
export class SessionProjection {
  private readonly observations = new Map<string, Map<string, SessionWatchRow>>();
  private projected = new Map<string, SessionWatchRow>();
  private selected = new Map<string, string>();
  private sequence = 0;
  private readonly streamId = randomUUID();

  /** Only the selected observation may publish execution-owned attention. */
  rowForObservation(scope: string, rowKey: string): SessionWatchRow | undefined {
    const key = this.selected.get(`${normalizeHost(scope)}\0${rowKey}`);
    return key ? this.projected.get(key) : undefined;
  }

  apply(event: SessionWatchEnvelope): SessionWatchEnvelope[] {
    const scope = normalizeHost(event.scope);
    if (event.type === 'reset') this.observations.set(scope, new Map(event.rows.map(row => [row.rowKey, row])));
    if (event.type === 'upsert') {
      if (!this.observations.has(scope)) this.observations.set(scope, new Map());
      this.observations.get(scope)!.set(event.rowKey, event.row);
    }
    if (event.type === 'remove') this.observations.get(scope)?.delete(event.rowKey);
    const stamp = () => ({ version: 1 as const, streamId: this.streamId, sequence: ++this.sequence, capturedAt: event.capturedAt });
    if (event.type === 'scope' || event.type === 'heartbeat') {
      // An unavailable owner retains its last observation until its next reset.
      return [{ ...event, ...stamp(), scope }];
    }
    // A launch exists before a non-Claude harness mints its session id. Join an
    // id-less placeholder only through an exact, unambiguous durable launch id.
    const launchSessions = new Map<string, Set<string>>();
    for (const [observer, rows] of this.observations) for (const row of rows.values()) {
      if (!row.launchId || !row.sessionId) continue;
      const owner = normalizeHost(row.machine || row.sourceDevice || observer);
      const launch = `${owner}\0${row.kind}\0${row.launchId}`;
      const ids = launchSessions.get(launch) ?? new Set<string>();
      ids.add(row.sessionId);
      launchSessions.set(launch, ids);
    }
    const groups = new Map<string, { scope: string; row: SessionWatchRow }[]>();
    for (const [observer, rows] of this.observations) for (const row of rows.values()) {
      const owner = normalizeHost(row.machine || row.sourceDevice || observer);
      const launchIds = row.launchId ? launchSessions.get(`${owner}\0${row.kind}\0${row.launchId}`) : undefined;
      const sessionId = row.sessionId || (launchIds?.size === 1 ? [...launchIds][0] : undefined);
      const identity = sessionId ? `${row.kind}\0${sessionId}` : `${observer}\0${row.rowKey}`;
      const key = createHash('sha256').update(`${owner}\0${identity}`).digest('base64url').slice(0, 22);
      const group = groups.get(key) ?? [];
      group.push({ scope: observer, row });
      groups.set(key, group);
    }
    const next = new Map<string, SessionWatchRow>();
    const selected = new Map<string, string>();
    for (const [rowKey, observations] of groups) {
      const owner = normalizeHost(observations[0].row.machine || observations[0].row.sourceDevice || observations[0].scope);
      const authoritative = observations.filter(item => item.scope === owner);
      // Once the owner has answered, its absence is authoritative too. A stale
      // launcher/history mirror cannot resurrect a removed execution.
      const candidates = authoritative.length ? authoritative : this.observations.has(owner) ? [] : observations;
      candidates.sort((a, b) => Number(a.row.previous) - Number(b.row.previous)
        || (b.row.lastActivityMs ?? b.row.startedAtMs ?? 0) - (a.row.lastActivityMs ?? a.row.startedAtMs ?? 0)
        || a.row.rowKey.localeCompare(b.row.rowKey));
      const candidate = candidates[0];
      const chosen = candidate?.row;
      if (!chosen) continue;
      selected.set(`${candidate.scope}\0${chosen.rowKey}`, rowKey);
      const observerTerminals = observations.filter(item => !item.row.previous && (item.row.terminalId || item.row.viewingIn || item.row.provenance?.reply))
        .map(({ scope: device, row }) => ({ device, terminalId: row.terminalId, launchId: row.launchId, viewingIn: row.viewingIn, provenance: row.provenance }))
        .sort((a, b) => a.device.localeCompare(b.device) || (a.terminalId ?? '').localeCompare(b.terminalId ?? ''));
      next.set(rowKey, {
        ...chosen, rowKey, sourceDevice: owner, machine: owner,
        observerTerminals,
        recovery: chosen.resumable && chosen.sessionId
          ? { command: 'agents', args: ['sessions', 'resume', chosen.sessionId, '--device', owner], ...(chosen.cwd ? { cwd: chosen.cwd } : {}) }
          : null,
      });
    }
    const result: SessionWatchEnvelope[] = [];
    // A reset still replaces only its source scope. Cross-scope migrations are
    // explicit removes/upserts, so existing clients converge without a new API.
    if (event.type === 'reset') result.push({ ...stamp(), type: 'reset', scope, rows: [...next.values()].filter(row => row.sourceDevice === scope) });
    for (const [key, row] of this.projected) if (!next.has(key) && !(event.type === 'reset' && row.sourceDevice === scope)) {
      result.push({ ...stamp(), type: 'remove', scope: row.sourceDevice, rowKey: key });
    }
    for (const [key, row] of next) if (!(event.type === 'reset' && row.sourceDevice === scope) && JSON.stringify(this.projected.get(key)) !== JSON.stringify(row)) {
      result.push({ ...stamp(), type: 'upsert', scope: row.sourceDevice, rowKey: key, row });
    }
    this.projected = next;
    this.selected = selected;
    return result;
  }
}
