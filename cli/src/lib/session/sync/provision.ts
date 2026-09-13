// Cloudflare orchestration for the managed session-backup store. The generic
// request primitives live in share/provision; only the isolated sessions
// resource choices and Worker template belong here. Mirrors lib/traces/provision.ts.
//
// This is the OPERATOR provisioning path — cutting the `agents-sessions` Worker +
// bucket + custom domain once. Product traffic never runs it; a signed-in user
// talks to the already-deployed Worker through `SessionsHttpClient`.

import {
  addCustomDomain,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  putWorkerSecret,
  type CloudflareRequester,
} from '../../share/provision.js';
import {
  DEFAULT_SESSIONS_BUCKET_NAME,
  DEFAULT_SESSIONS_DOMAIN,
  DEFAULT_SESSIONS_WORKER_NAME,
} from './managed-config.js';
import { renderSessionsWorkerScript } from './worker-template.js';

interface ProvisionOptions {
  request?: CloudflareRequester;
}

/** Bind the Phoenix identity base URL used to verify every session read and write. */
export async function setPhoenixIdBaseSecret(
  apiToken: string,
  accountId: string,
  workerName: string,
  phoenixIdBase: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const normalized = phoenixIdBase.replace(/\/+$/, '').trim();
  if (!normalized) throw new Error('PHOENIX_ID_BASE is required to verify session requests.');
  await putWorkerSecret(apiToken, accountId, workerName, 'PHOENIX_ID_BASE', normalized, opts);
}

export interface ProvisionSessionsOptions extends ProvisionOptions {
  apiToken: string;
  accountId: string;
  workerName?: string;
  bucketName?: string;
  phoenixIdBase: string;
  domain?: string;
}

/** Provision the complete isolated sessions deployment using the canonical Worker template. */
export async function provisionSessions(opts: ProvisionSessionsOptions): Promise<{ baseUrl: string }> {
  const domain = opts.domain ?? DEFAULT_SESSIONS_DOMAIN;
  const workerName = opts.workerName ?? DEFAULT_SESSIONS_WORKER_NAME;
  const bucketName = opts.bucketName ?? DEFAULT_SESSIONS_BUCKET_NAME;
  const requestOpts = opts.request ? { request: opts.request } : {};

  await createBucket(opts.apiToken, opts.accountId, bucketName, requestOpts);
  await deployWorker(
    opts.apiToken,
    opts.accountId,
    workerName,
    renderSessionsWorkerScript(),
    bucketName,
    requestOpts,
  );
  // No WRITE_TOKEN secret: the managed sessions Worker is Phoenix-only (PHNX-3726).
  // A static token would be a Phoenix-and-quota bypass with no legitimate caller —
  // the zero-knowledge BYO path uses the user's own R2 bucket directly, never this
  // Worker.
  await setPhoenixIdBaseSecret(
    opts.apiToken,
    opts.accountId,
    workerName,
    opts.phoenixIdBase,
    requestOpts,
  );
  const workersDevSubdomain = await enableWorkersDev(
    opts.apiToken,
    opts.accountId,
    workerName,
    requestOpts,
  );
  const zoneId = await findZoneId(opts.apiToken, domain, requestOpts);
  if (!zoneId) {
    return { baseUrl: `https://${workerName}.${workersDevSubdomain}.workers.dev` };
  }
  await addCustomDomain(opts.apiToken, opts.accountId, workerName, zoneId, domain, requestOpts);
  return { baseUrl: `https://${domain}` };
}
