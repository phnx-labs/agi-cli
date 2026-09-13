// Cloudflare provisioning for `agents artifacts setup` — plain `fetch` against the CF
// REST API (the repo has no CF wrapper). Creates the R2 bucket, configures its
// lifecycle, uploads the Worker (with an R2 binding), sets the WRITE_TOKEN secret,
// enables the free `*.workers.dev` subdomain, and — when the token owns the zone —
// maps a custom domain.

import { createHash } from 'node:crypto';
import type { WorkerBundle } from './worker-template.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
export const SHARE_LIFECYCLE_RULE_ID = 'agents-share-expire-objects';
export const SHARE_LIFECYCLE_RETENTION_DAYS = 366;
const SECONDS_PER_DAY = 86400;

interface CfError {
  code?: number;
  message?: string;
}

interface R2LifecycleRule {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  deleteObjectsTransition?: {
    condition: { type: 'Age'; maxAge: number } | { type: 'Date'; date: string };
  };
  abortMultipartUploadsTransition?: {
    condition?: { type: 'Age'; maxAge: number };
  };
  storageClassTransitions?: Array<{
    condition: { type: 'Age'; maxAge: number } | { type: 'Date'; date: string };
    storageClass: 'InfrequentAccess';
  }>;
}

export interface CloudflareRequest {
  apiToken: string;
  method: string;
  pathname: string;
  body?: unknown;
  form?: FormData;
}

export type CloudflareRequester = <T = unknown>(request: CloudflareRequest) => Promise<T>;

async function cf<T = unknown>(
  apiToken: string,
  method: string,
  pathname: string,
  body?: unknown,
  form?: FormData,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiToken}` };
  let payload: FormData | string | undefined;
  if (form) {
    payload = form; // fetch sets multipart boundary
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${CF_API}${pathname}`, { method, headers, body: payload });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: CfError[];
    result?: T;
  };
  if (!res.ok || json.success === false) {
    const msg =
      (json.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') ||
      res.statusText;
    throw new Error(`Cloudflare ${method} ${pathname} failed (${res.status}): ${msg}`);
  }
  return json.result as T;
}

const defaultCloudflareRequester: CloudflareRequester = <T = unknown>(request: CloudflareRequest) =>
  cf<T>(request.apiToken, request.method, request.pathname, request.body, request.form);

interface ProvisionOptions {
  request?: CloudflareRequester;
}

/** True if the CF error looks like "the thing already exists" (idempotent create). */
function isAlreadyExists(e: unknown): boolean {
  return /already exists|duplicate|10004|10014/i.test(String(e));
}

/** Create the R2 bucket (idempotent). */
export async function createBucket(
  apiToken: string,
  accountId: string,
  name: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  try {
    await request({
      apiToken,
      method: 'POST',
      pathname: `/accounts/${accountId}/r2/buckets`,
      body: { name },
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
}

export function buildShareLifecycleRule(days: number = SHARE_LIFECYCLE_RETENTION_DAYS): R2LifecycleRule {
  return {
    id: SHARE_LIFECYCLE_RULE_ID,
    enabled: true,
    conditions: { prefix: '' },
    deleteObjectsTransition: {
      condition: { type: 'Age', maxAge: days * SECONDS_PER_DAY },
    },
  };
}

export function mergeShareLifecycleRule(
  existing: R2LifecycleRule[] = [],
  rule: R2LifecycleRule = buildShareLifecycleRule(),
): R2LifecycleRule[] {
  return [...existing.filter((r) => r.id !== SHARE_LIFECYCLE_RULE_ID), rule];
}

/** Ensure the share bucket self-cleans old objects. Exact per-link expiry is enforced by the Worker. */
export async function configureBucketLifecycle(
  apiToken: string,
  accountId: string,
  bucketName: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  const lifecycle = await request<{ rules?: R2LifecycleRule[] }>({
    apiToken,
    method: 'GET',
    pathname: `/accounts/${accountId}/r2/buckets/${bucketName}/lifecycle`,
  });
  await request({
    apiToken,
    method: 'PUT',
    pathname: `/accounts/${accountId}/r2/buckets/${bucketName}/lifecycle`,
    body: { rules: mergeShareLifecycleRule(lifecycle.rules ?? []) },
  });
}

/** Upload the module Worker with an R2 binding (`BUCKET`). Secrets are set via the Workers Secrets API. */
export async function deployWorker(
  apiToken: string,
  accountId: string,
  workerName: string,
  worker: string | WorkerBundle,
  bucketName: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2024-11-06',
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName },
    ],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  const bundle = typeof worker === 'string' ? { script: worker, modules: [] } : worker;
  form.set(
    'worker.js',
    new Blob([bundle.script], { type: 'application/javascript+module' }),
    'worker.js',
  );
  for (const module of bundle.modules) {
    form.set(module.name, new Blob([module.contents], { type: module.contentType }), module.name);
  }
  await request({
    apiToken,
    method: 'PUT',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}`,
    form,
  });
}

/** sha256 of the rendered Worker script, so a deployed endpoint can be compared
 * against the current `worker-template.ts` without redeploying to find out. */
export function hashWorkerScript(script: string): string {
  return createHash('sha256').update(script, 'utf8').digest('hex');
}

interface UpdateWorkerResult {
  /** sha256 of `script` (the hash the endpoint now matches, whether or not this
   * call actually redeployed). */
  templateHash: string;
  /** True when the upload was skipped because `previousHash` already matched. */
  skipped: boolean;
}

/** Cloudflare `secret_text` name the Worker reads as `env.PHOENIX_ID_BASE`. */
export const WORKER_PHOENIX_ID_BASE_SECRET = 'PHOENIX_ID_BASE';

/** Cloudflare `secret_text` name the Worker reads as `env.PRIX_ARTIFACT_COLLAB_BASE`. */
export const WORKER_COLLAB_BASE_SECRET = 'PRIX_ARTIFACT_COLLAB_BASE';
/** Cloudflare `secret_text` name the Worker reads as `env.ARTIFACT_COLLAB_SERVICE_TOKEN`. */
export const WORKER_COLLAB_SERVICE_TOKEN_SECRET = 'ARTIFACT_COLLAB_SERVICE_TOKEN';

type UpdateWorkerOpts = ProvisionOptions & {
  force?: boolean;
  /**
   * Phoenix ID base URL to bind as `PHOENIX_ID_BASE` after the script upload.
   * Pass this for a managed deployment; omit it for a pure-BYO Worker (which
   * authenticates only via WRITE_TOKEN). An empty string is a caller bug and
   * fails loud — do not pass a blank to "skip".
   */
  phoenixIdBase?: string;
  /**
   * Managed collaboration backend (PHNX-3835). BOTH must be present to enable
   * `/__collab`; pass neither to leave the surface disabled (the Worker fails it
   * closed). The service token rides Cloudflare's Secrets API, never rendered
   * HTML or browser JS. Applied like `phoenixIdBase` — only when defined.
   */
  collabBase?: string;
  collabServiceToken?: string;
};

/**
 * Re-deploy the Worker script against an ALREADY-provisioned endpoint (same
 * account/worker/bucket `deployWorker` was first called with) and idempotently
 * no-op when the template hasn't changed.
 *
 * Cloudflare's script-upload endpoint (`deployWorker`, above) replaces the
 * Worker's bindings/secrets wholesale on every call — there is no documented,
 * reliable way to tell it "keep the existing secret" (the `keep_bindings`
 * metadata field some third-party guides mention is absent from Cloudflare's
 * current Multipart upload metadata reference, and the community has reported
 * it not preventing binding loss even when present:
 * https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/,
 * https://community.cloudflare.com/t/upload-worker-module-endpoint-removes-existing-bindings-despite-keep-bindings/766447).
 * So instead this immediately re-applies WRITE_TOKEN via the documented Secrets
 * API right after the upload — the same two-call sequence first-time
 * provisioning already uses (`deployWorker` then `setWorkerSecret`), except
 * `writeToken` here is the caller's EXISTING token, never a freshly generated
 * one. A managed deploy also re-applies `PHOENIX_ID_BASE` the same way (the
 * Worker reads it to verify Phoenix bearers); a pure-BYO deploy omits it.
 * Cloudflare's own docs describe exactly this "secrets survive a
 * subsequent write" contract for the sibling `wrangler versions upload
 * --secrets-file` flow ("Secrets not included in the file are preserved from
 * the previous version" —
 * https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code);
 * re-setting the secret to its own value after every deploy gets the same
 * outcome without depending on an unverified upload-time flag.
 */
export async function updateWorker(
  apiToken: string,
  accountId: string,
  workerName: string,
  bucketName: string,
  worker: string | WorkerBundle,
  writeToken: string,
  previousHash: string | undefined,
  opts: UpdateWorkerOpts = {},
): Promise<UpdateWorkerResult> {
  const script = typeof worker === 'string' ? worker : worker.script;
  const templateHash = hashWorkerScript(script);
  if (!opts.force && previousHash === templateHash) {
    // Script is current so we skip the upload (which would wipe secrets). A
    // managed Worker still needs PHOENIX_ID_BASE present — a prior upload from
    // a CLI that never set it left the secret missing, and this is the heal
    // that does not require --force or a dummy template bump.
    if (opts.phoenixIdBase !== undefined) {
      await applyPhoenixIdBaseSecret(apiToken, accountId, workerName, opts.phoenixIdBase, opts);
    }
    await applyCollabSecrets(apiToken, accountId, workerName, opts);
    return { templateHash, skipped: true };
  }
  await deployWorker(apiToken, accountId, workerName, worker, bucketName, opts);
  // Script upload clears bindings/secrets (see JSDoc above). If re-applying
  // WRITE_TOKEN fails here, the live Worker has no write token — every
  // `agents artifacts share` publish/delete 401s until a re-run of `agents artifacts share update`
  // completes both steps. Surface that explicitly instead of the raw CF error.
  try {
    await setWorkerSecret(apiToken, accountId, workerName, writeToken, opts);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Worker deployed but the write token failed to re-apply — re-run \`agents artifacts share update\` to fix this before publishing/deleting anything. (${detail})`,
    );
  }
  if (opts.phoenixIdBase !== undefined) {
    try {
      await applyPhoenixIdBaseSecret(apiToken, accountId, workerName, opts.phoenixIdBase, opts);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Worker deployed but PHOENIX_ID_BASE failed to re-apply — Phoenix-bearer publishes will 401 until you re-run \`agents artifacts share update\`. (${detail})`,
      );
    }
  }
  // The script upload wiped bindings/secrets (see JSDoc above), so re-apply the
  // collaboration secrets too — but only when the caller provided them. An
  // ordinary deploy with collaboration still dormant passes neither and the
  // Worker keeps failing `/__collab` closed.
  try {
    await applyCollabSecrets(apiToken, accountId, workerName, opts);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Worker deployed but the collaboration secrets failed to re-apply — \`/__collab\` stays disabled until you re-run \`agents artifacts share update\`. (${detail})`,
    );
  }
  return { templateHash, skipped: false };
}

/**
 * Bind the managed collaboration secrets (PHNX-3835) — both or neither. A no-op
 * when the caller passed neither (collaboration dormant), so a plain managed
 * deploy never touches them; fails loud on a half-config (one without the other).
 */
async function applyCollabSecrets(
  apiToken: string,
  accountId: string,
  workerName: string,
  opts: UpdateWorkerOpts,
): Promise<void> {
  if (opts.collabBase === undefined && opts.collabServiceToken === undefined) return;
  if (opts.collabBase === undefined || opts.collabServiceToken === undefined) {
    throw new Error(
      'Managed collaboration needs BOTH PRIX_ARTIFACT_COLLAB_BASE and ARTIFACT_COLLAB_SERVICE_TOKEN — set both or neither.',
    );
  }
  await putWorkerSecret(apiToken, accountId, workerName, WORKER_COLLAB_BASE_SECRET, opts.collabBase, opts);
  await putWorkerSecret(apiToken, accountId, workerName, WORKER_COLLAB_SERVICE_TOKEN_SECRET, opts.collabServiceToken, opts);
}

/** Add/update a secret_text binding using Cloudflare's Workers Secrets API. */
export async function putWorkerSecret(
  apiToken: string,
  accountId: string,
  workerName: string,
  name: string,
  text: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  await request({
    apiToken,
    method: 'PUT',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
    body: { name, text, type: 'secret_text' },
  });
}

/** Add/update the WRITE_TOKEN binding using Cloudflare's Workers Secrets API. */
export async function setWorkerSecret(
  apiToken: string,
  accountId: string,
  workerName: string,
  writeToken: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  await putWorkerSecret(apiToken, accountId, workerName, 'WRITE_TOKEN', writeToken, opts);
}

function normalizePhoenixIdBase(phoenixIdBase: string): string {
  const base = phoenixIdBase.replace(/\/+$/, '').trim();
  if (!base) {
    throw new Error(
      'Managed share deploy requires a non-empty PHOENIX_ID_BASE so the Worker can verify Phoenix bearers. Set the PHOENIX_ID_BASE env var.',
    );
  }
  return base;
}

async function applyPhoenixIdBaseSecret(
  apiToken: string,
  accountId: string,
  workerName: string,
  phoenixIdBase: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  await putWorkerSecret(
    apiToken,
    accountId,
    workerName,
    WORKER_PHOENIX_ID_BASE_SECRET,
    normalizePhoenixIdBase(phoenixIdBase),
    opts,
  );
}

/** Enable the free `*.workers.dev` route for the script, and return the account subdomain. */
export async function enableWorkersDev(
  apiToken: string,
  accountId: string,
  workerName: string,
  opts: ProvisionOptions = {},
): Promise<string> {
  const request = opts.request ?? defaultCloudflareRequester;
  await request({
    apiToken,
    method: 'POST',
    pathname: `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    body: {
      enabled: true,
      previews_enabled: false,
    },
  });
  const sub = await request<{ subdomain?: string }>({
    apiToken,
    method: 'GET',
    pathname: `/accounts/${accountId}/workers/subdomain`,
  });
  if (!sub?.subdomain) {
    throw new Error(
      'No workers.dev subdomain on this account yet — register one at dash.cloudflare.com → Workers → Subdomain, then re-run.',
    );
  }
  return sub.subdomain;
}

/** Resolve a zone id for a domain the token can see, or null if not owned/visible. */
export async function findZoneId(
  apiToken: string,
  domain: string,
  opts: ProvisionOptions = {},
): Promise<string | null> {
  const request = opts.request ?? defaultCloudflareRequester;
  // Try the exact name, then the registrable parent (share.getrush.ai -> getrush.ai).
  const candidates = [domain, domain.split('.').slice(-2).join('.')];
  for (const name of candidates) {
    const zones = await request<Array<{ id: string; name: string }>>({
      apiToken,
      method: 'GET',
      pathname: `/zones?name=${encodeURIComponent(name)}`,
    }).catch(() => [] as Array<{ id: string; name: string }>);
    if (zones?.length) return zones[0].id;
  }
  return null;
}

/** Map a custom hostname (e.g. `share.getrush.ai`) to the Worker via Workers Custom Domains. */
export async function addCustomDomain(
  apiToken: string,
  accountId: string,
  workerName: string,
  zoneId: string,
  hostname: string,
  opts: ProvisionOptions = {},
): Promise<void> {
  const request = opts.request ?? defaultCloudflareRequester;
  try {
    await request({
      apiToken,
      method: 'PUT',
      pathname: `/accounts/${accountId}/workers/domains`,
      body: {
        zone_id: zoneId,
        hostname,
        service: workerName,
        environment: 'production',
      },
    });
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
}
