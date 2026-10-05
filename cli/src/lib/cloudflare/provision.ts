
const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfError {
  code?: number;
  message?: string;
}

export interface WorkerModule {
  name: string;
  contentType: string;
  contents: Uint8Array<ArrayBuffer>;
}

export interface WorkerBundle {
  script: string;
  modules: WorkerModule[];
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
    payload = form;
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

function isAlreadyExists(e: unknown): boolean {
  return /already exists|duplicate|10004|10014/i.test(String(e));
}

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

export async function findZoneId(
  apiToken: string,
  domain: string,
  opts: ProvisionOptions = {},
): Promise<string | null> {
  const request = opts.request ?? defaultCloudflareRequester;
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
