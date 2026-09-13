// Cloudflare orchestration for the private agents-traces store. The generic
// request primitives live in cloudflare/provision; only the isolated traces resource
// choices and Worker template belong here.

import { randomBytes } from 'node:crypto';
import {
  addCustomDomain,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  putWorkerSecret,
  type CloudflareRequester,
} from '../cloudflare/provision.js';
import { DEFAULT_TRACES_DOMAIN } from './backend.js';
import { renderTracesWorkerScript } from './worker-template.js';

interface ProvisionOptions {
  request?: CloudflareRequester;
}

/** Bind the Phoenix identity base URL used to verify every trace read and write. */
async function setPhoenixIdBaseSecret(
  apiToken: string,
  accountId: string,
  workerName: string,
  phoenixIdBase: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const normalized = phoenixIdBase.replace(/\/+$/, '').trim();
  if (!normalized) throw new Error('PHOENIX_ID_BASE is required to verify trace requests.');
  await putWorkerSecret(apiToken, accountId, workerName, 'PHOENIX_ID_BASE', normalized, opts);
}

interface ProvisionTracesOptions extends ProvisionOptions {
  apiToken: string;
  accountId: string;
  workerName: string;
  bucketName: string;
  phoenixIdBase: string;
  domain?: string;
}

/** Provision the complete isolated traces deployment using the canonical Worker template. */
export async function provisionTraces(opts: ProvisionTracesOptions): Promise<{ baseUrl: string }> {
  const domain = opts.domain ?? DEFAULT_TRACES_DOMAIN;
  const requestOpts = opts.request ? { request: opts.request } : {};

  await createBucket(opts.apiToken, opts.accountId, opts.bucketName, requestOpts);
  await deployWorker(
    opts.apiToken,
    opts.accountId,
    opts.workerName,
    renderTracesWorkerScript(),
    opts.bucketName,
    requestOpts,
  );
  await putWorkerSecret(
    opts.apiToken,
    opts.accountId,
    opts.workerName,
    'WRITE_TOKEN',
    randomBytes(32).toString('hex'),
    requestOpts,
  );
  await setPhoenixIdBaseSecret(
    opts.apiToken,
    opts.accountId,
    opts.workerName,
    opts.phoenixIdBase,
    requestOpts,
  );
  const workersDevSubdomain = await enableWorkersDev(
    opts.apiToken,
    opts.accountId,
    opts.workerName,
    requestOpts,
  );
  const zoneId = await findZoneId(opts.apiToken, domain, requestOpts);
  if (!zoneId) {
    return { baseUrl: `https://${opts.workerName}.${workersDevSubdomain}.workers.dev` };
  }
  await addCustomDomain(opts.apiToken, opts.accountId, opts.workerName, zoneId, domain, requestOpts);
  return { baseUrl: `https://${domain}` };
}
