
import { AwsClient } from 'aws4fetch';
import type { R2Config } from './config.js';

interface HeadResult {
  size: number;
  etag: string;
}

export class R2Client {
  readonly kind = 'byo' as const;
  private aws: AwsClient;
  private base: string;

  constructor(cfg: R2Config) {
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    this.base = `${cfg.endpoint}/${encodeURIComponent(cfg.bucket)}`;
  }

  private url(key: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${this.base}/${encoded}`;
  }

  async put(key: string, body: string | Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.aws.fetch(this.url(key), {
      method: 'PUT',
      body,
      headers: { 'content-type': contentType },
    });
    if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await safeText(res)}`);
  }

  async get(key: string): Promise<string | null> {
    const res = await this.aws.fetch(this.url(key), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${await safeText(res)}`);
    return await res.text();
  }

  async head(key: string): Promise<HeadResult | null> {
    const res = await this.aws.fetch(this.url(key), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD ${key} failed: ${res.status}`);
    return {
      size: Number(res.headers.get('content-length') ?? '0'),
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
    }
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ 'list-type': '2', prefix, delimiter: '/' });
      if (token) params.set('continuation-token', token);
      const res = await this.aws.fetch(`${this.base}?${params.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`R2 LIST(prefixes) ${prefix} failed: ${res.status} ${await safeText(res)}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) {
        prefixes.push(decodeXml(m[1]));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
    } while (token);
    return prefixes;
  }

  async list(prefix = ''): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ 'list-type': '2', prefix });
      if (token) params.set('continuation-token', token);
      const res = await this.aws.fetch(`${this.base}?${params.toString()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`R2 LIST ${prefix} failed: ${res.status} ${await safeText(res)}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
        keys.push(decodeXml(m[1]));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
    } while (token);
    return keys;
  }
}

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
