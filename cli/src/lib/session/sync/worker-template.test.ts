import { describe, expect, it } from 'vitest';
import { renderSessionsWorkerScript } from './worker-template.js';


describe('renderSessionsWorkerScript', () => {
  const source = renderSessionsWorkerScript();

  it('emits the complete private blob-store route surface', () => {
    expect(source).toContain("request.method === 'PUT'");
    expect(source).toContain("request.method === 'GET' || request.method === 'HEAD'");
    expect(source).toContain("request.method === 'DELETE'");
    expect(source).toContain("url.searchParams.has('list')");
    expect(source).toContain('env.BUCKET.list(');
  });

  it('verifies Phoenix bearers through the canonical identity route', () => {
    expect(source).toContain("base + '/api/v1/auth/me'");
    expect(source).toContain("headers: { Authorization: 'Bearer ' + presented }");
    expect(source).toContain("ownerId !== claims.userId");
  });

  it('keeps opaque encrypted objects out of the traces aggregate path', () => {
    expect(source).not.toContain('mergeIndexShards');
    expect(source).not.toContain("segments[1] === 'all'");
  });

  it('ships immutable DEK escrow and CAS quota enforcement in the artifact', () => {
    expect(source).toContain("rel === '__key/backup-dek'");
    expect(source).toContain("onlyIf: { etagDoesNotMatch: '*' }");
    expect(source).toContain("function usageKey(owner) { return '__usage/' + owner; }");
    expect(source).toContain('onlyIf = { etagMatches: prevEtag }');
    expect(source).toContain("reject: json({ error: 'storage limit reached'");
    expect(source).toContain('usage.pending[operation.token]');
    expect(source).toContain('usage.settled[operation.pathId]');
    expect(source).toContain('mutationToken: lease.token');
    expect(source).toContain('return false;');
    expect(source).toContain("return '__mutation/' + owner + '/' + await mutationPathId(path)");
    expect(source).toContain('async function acquireMutationLease(env, owner, path)');
    expect(source).toContain('expiresAt: 0');
    expect(source).toContain("deleted: 'true'");
    expect(source).toContain("onlyIf: { etagMatches: existing.etag }");
    expect(source).toContain("obj.alg === 'aes-256-gcm'");
    expect(source).toContain('base64ByteLength(obj.iv) === 12');
    expect(source).toContain('base64ByteLength(obj.tag) === 16');
    expect(source).toContain("header.kind !== 'agents-session-bundle'");
    expect(source).toContain('maxPaths: 200000');
    expect(source).toContain('async function reserveMutationPath(env, owner, pathId, limits)');
    expect(source).toContain("error: 'historical path limit reached'");
  });
});
