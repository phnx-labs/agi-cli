
import {
  addCustomDomain,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  putWorkerSecret,
  type CloudflareRequester,
} from '../../cloudflare/provision.js';
import {
  DEFAULT_SESSIONS_BUCKET_NAME,
  DEFAULT_SESSIONS_DOMAIN,
  DEFAULT_SESSIONS_WORKER_NAME,
} from './managed-config.js';
import { renderSessionsWorkerScript } from './worker-template.js';

interface ProvisionOptions {
  request?: CloudflareRequester;
}

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
