import { buildSync } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Cloudflare Worker that fronts the R2 share bucket.
//
// One tiny Worker does both sides:
//   - PUT  /<username>/<slug>  — write-gated by authorizeWrite's THREE principals
//     (not a fallback chain — each is a distinct legitimate identity):
//       1. Static WRITE_TOKEN (BYO Cloudflare) — checked first when the presented
//          bearer equals env.WRITE_TOKEN. owner = env.SHARE_NAMESPACE or the
//          path's first segment.
//       2. Phoenix bearer — otherwise GET ${env.PHOENIX_ID_BASE}/api/v1/auth/me
//          with that bearer → {userId,email}; 401 if absent/invalid.
//          customMetadata.owner = userId (stable). The path's first segment MUST
//          equal handleFromEmail(email) (the public handle, e.g. muqsitnawaz),
//          or an explicit x-share-handle the caller chose (--handle), so one user
//          cannot write another's prefix (403 namespace mismatch).
//          A __handles/<handle> claim binds the handle to the first userId that
//          writes it and records the verified email; a different userId gets 409
//          handle taken, EXCEPT when its verified email matches the claim's — the
//          same human re-authenticated under a new userId — in which case the
//          claim and the old account's objects transfer instead of dead-ending
//          (PHNX-3547).
//       3. __share HMAC cookie — the signed-in viewer's identity cookie (same
//          {userId,email} identityFromCookie verifies for GET). Lets the shared
//          page's inline visibility control PATCH with credentials:'include' and
//          no bearer; SameSite=Lax blocks it cross-site, and the same namespace/
//          owner checks confine it to the holder's own pages. Applies to PUT,
//          PATCH, and DELETE alike, since all three share authorizeWrite.
//     A managed deployment sets PHOENIX_ID_BASE; BYO sets WRITE_TOKEN; the
//     platform endpoint may set both. Fail loud (401) when none authenticates.
//     Writes the body to R2 via the BUCKET binding, storing visibility
//     (public|unlisted|me|org), owner, org_domain (org only), an optional
//     expires-at, plus provenance (agent/session/host/repo/date), a label, and
//     any `--meta` entries in object metadata. me/org require a Phoenix
//     identity (BYO WRITE_TOKEN cannot publish them). org from a public inbox
//     domain is 400. Overwriting an existing slug first copies the current
//     object to <slug>/rev-<ts>-<rand> (revision history) unless
//     x-share-no-revision is set.
//   - PATCH /<username>/<slug> — authenticated metadata-only edit. Rewrites the
//     exact existing body with all HTTP/custom metadata preserved except the
//     explicitly requested label/arbitrary metadata changes; never revisions.
//     Conditional put (onlyIf etagMatches) so a concurrent republish 409s
//     instead of rolling the body back. Ownership is the handle claim's call,
//     exactly as on DELETE (assertHandleOwner: the __handles/<handle> claim, or
//     the pre-claim rival-userId scan) — there is no per-object owner compare,
//     and the stamp is left untouched; WRITE_TOKEN is the admin repair path.
//   - GET  /<username>/<slug>  — public|unlisted are anonymous; me requires the
//     Phoenix owner (the stamped owner, or the holder of the namespace's
//     __handles claim), org requires a same-domain Phoenix identity (Bearer, then
//     HMAC cookie, then phoenix_ticket). Unauthenticated me/org 302s to
//     Phoenix login (or 401 JSON if PHOENIX_ID_BASE is unset). 410s (and lazily
//     deletes) once its expiry has passed. A bucket lifecycle rule is the durable
//     sweeper; this is the immediate gate.
//   - GET  /<username>/<slug>?revisions=json — machine-readable history of the
//     retained prior versions under that slug, newest first.
//   - GET  /<username>         — public gallery of that user's shares (HTML).
//   - GET  /<username>?format=json — public machine-readable listing of that user's
//     ACTIVE shares (`agents artifacts share list`). Same single-segment path as the HTML
//     gallery and gated on the SAME "does <username>/ hold any object" check, so it
//     only intercepts a genuine namespace — a legacy flat slug with ?format=json
//     still serves its real content, never a fake empty listing.
//   - GET  /<slug>             — backward-compat flat slug (legacy shares before
//     per-user namespaces).
//
// Emitted as a string, so it compiles into `dist/**` and ships with no
// package.json#files change. `provision.ts` uploads
// this verbatim as an ES-module Worker with a BUCKET (R2) binding + a WRITE_TOKEN secret.

/**
 * Render the Worker source. Pure — the R2 binding + token are wired at deploy time.
 *
 * The literal below still spells the CLI `agents share` in its provenance comment,
 * its root response, and its gallery title, even though the command is now
 * `agents artifacts share` (RUSH-2580). That is deliberate: `hashWorkerScript` of
 * this exact text is what `shareTemplateStatus` compares a provisioned endpoint's
 * recorded `templateHash` against, so editing ANY byte here marks every already-
 * deployed endpoint `outdated` — which makes `agents artifacts share list` refuse
 * until its owner re-runs `agents artifacts share update`. Cosmetic renames are not
 * worth that; change this text only alongside a real Worker behavior change.
 */
export interface WorkerModule {
  name: string;
  contentType: 'application/wasm';
  contents: Uint8Array<ArrayBuffer>;
}

export interface WorkerBundle {
  script: string;
  modules: WorkerModule[];
}

let bundledWorker: WorkerBundle | undefined;
let nodeWorkerScript: string | undefined;

/** Bundle the Worker renderer into an ES module plus workerd-compiled WASM modules. */
export function renderWorkerBundle(): WorkerBundle {
  if (bundledWorker) return bundledWorker;
  const result = buildSync({
    stdin: {
      contents: renderWorkerSource(),
      loader: 'js',
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      sourcefile: 'agents-share-worker.js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    outdir: 'worker-bundle',
    assetNames: '[name]-[hash]',
    minify: true,
    // Fonts are plain data and can live in JavaScript. WASM must remain a
    // compiled module: workerd deliberately forbids runtime code generation,
    // so esbuild's `binary` loader produces a bundle that works in Node but
    // throws "Wasm code generation disallowed by embedder" in Cloudflare.
    loader: { '.wasm': 'copy', '.woff': 'binary' },
  });
  const script = result.outputFiles.find((output) => output.path.endsWith('.js'));
  if (!script) throw new Error('Worker bundling produced no JavaScript output.');
  const modules = result.outputFiles
    .filter((output) => output.path.endsWith('.wasm'))
    .map((output) => ({
      name: output.path.split('/').pop()!,
      contentType: 'application/wasm' as const,
      contents: new Uint8Array(output.contents),
    }));
  if (modules.length !== 2) {
    throw new Error(`Worker bundling produced ${modules.length} WASM modules; expected yoga and resvg.`);
  }
  bundledWorker = { script: script.text, modules };
  return bundledWorker;
}

/** Single-file representation for direct Node tests, which cannot import compiled WASM modules. */
export function renderWorkerScript(): string {
  if (nodeWorkerScript) return nodeWorkerScript;
  const result = buildSync({
    stdin: {
      contents: renderWorkerSource(),
      loader: 'js',
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      sourcefile: 'agents-share-worker.js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: true,
    loader: { '.wasm': 'binary', '.woff': 'binary' },
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('Worker test bundling produced no JavaScript output.');
  nodeWorkerScript = output.text;
  return nodeWorkerScript;
}

/** Unbundled Worker source. Kept separate so esbuild can resolve npm modules. */
export function renderWorkerSource(): string {
  return `import satori, { init as initSatori } from 'satori/wasm';
import initYoga from 'yoga-wasm-web';
import { Resvg, initWasm as initResvg } from '@resvg/resvg-wasm';
import yogaWasm from 'yoga-wasm-web/dist/yoga.wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import interRegular from '@fontsource/inter/files/inter-latin-400-normal.woff';
import interBold from '@fontsource/inter/files/inter-latin-700-normal.woff';
import jetbrainsMono from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff';

// GENERATED by agents-cli agents share setup — do not edit here; edit
// src/lib/share/worker-template.ts and re-run setup.
export const hooks = {
  verifyPhoenixToken: defaultVerifyPhoenixToken,
  renderOgCard: renderOgCard,
  collabFetch: defaultCollabFetch,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.replace(/^\\/+/, ''));

    if (!path) {
      return new Response('agents share — POST is not it; PUT /<username>/<slug> to publish, GET /<username>/<slug> to view.', {
        status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const firstSeg = path.split('/').filter(Boolean)[0] || '';

    // Same-origin human collaboration transport (PHNX-3835). Every /__collab/*
    // verb loads the R2 share object FIRST, re-derives identity/visibility/
    // provenance server-side, reuses the exact page read gate, then proxies to
    // the Prix artifact-collaboration API with the service token (never surfaced
    // to the browser). Routed BEFORE the __-prefix GET 404 guard below because
    // GET /__collab/context|threads|events are first-class. Fails closed (404)
    // when the managed backend is unconfigured — BYO has no Phoenix identity, so
    // managed collaboration correctly does not exist there.
    if (firstSeg === '__collab') {
      return handleCollab(request, env, url, path, ctx);
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && firstSeg.startsWith('__')) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    // POST /__ticket — mint a short-lived, single-navigation login ticket for the
    // authenticated owner (PHNX-3370). The CLI (which holds the Phoenix bearer)
    // calls this, then opens the owner's page with ?phoenix_ticket=<t> so the
    // browser trades it for the __share cookie and the inline visibility control
    // goes live. The ticket is SELF-signed with the Worker's own HMAC secret — no
    // external ticket service — and carries the SAME identity authorizeWrite
    // already proved, so it grants nothing the caller didn't already have.
    if (request.method === 'POST' && firstSeg === '__ticket') {
      const auth = await authorizeWrite(request, env);
      if (auth.error) return auth.error;
      const ticket = await signSelfTicket({ userId: auth.owner, email: auth.email || '' }, env);
      if (!ticket) return json({ error: 'ticket minting is not configured' }, 501);
      return json({ ticket: ticket }, 200);
    }

    if (request.method === 'PUT') {
      const auth = await authorizeWrite(request, env);
      if (auth.error) return auth.error;
      const vis = normalizeVisibility(request.headers.get('x-share-visibility'));
      if (vis.error) return vis.error;
      const visibility = vis.value;
      if (visibility === 'me' || visibility === 'org') {
        const phoenixBase = typeof env.PHOENIX_ID_BASE === 'string' ? env.PHOENIX_ID_BASE.replace(/\\/+$/, '') : '';
        if (auth.kind !== 'phoenix' || !phoenixBase) {
          return json({ error: 'visibility me/org requires Phoenix identity' }, 400);
        }
        if (visibility === 'org') {
          const domain = emailDomain(auth.email);
          if (!domain) return json({ error: 'org visibility requires a verified email domain' }, 400);
          if (PUBLIC_INBOX_DOMAINS.indexOf(domain) !== -1) {
            return json({ error: 'org visibility cannot use a public email domain', domain: domain }, 400);
          }
        }
      }
      // Token-gated read auth (PHNX-3654). A 'private' page is served only to a
      // request carrying the matching viewer key; we store just its SHA-256 hash
      // so the secret never lands in R2 metadata. Any write principal (Phoenix or
      // BYO WRITE_TOKEN) may publish 'private' — the gate is the token, not an
      // identity, unlike me/org. The token is mandatory: a private page with no
      // stored hash fails closed on read, so refuse the write instead.
      let viewerTokenHash = '';
      if (visibility === 'private') {
        const rawToken = request.headers.get('x-share-viewer-token') || '';
        if (!rawToken) return json({ error: 'visibility private requires a viewer token' }, 400);
        viewerTokenHash = await sha256Hex(rawToken);
      }
      const segments = path.split('/').filter(Boolean);
      if (auth.kind === 'phoenix') {
        // The caller's handle is normally derived from the email local-part. An
        // explicit x-share-handle (the CLI's --handle, PHNX-3547) lets a Phoenix
        // user choose a DIFFERENT free handle — the escape hatch when their
        // derived handle is taken or they want a vanity namespace. Sanitized to
        // the same [a-z0-9-] shape; claim rules below bind it first-writer-writes,
        // exactly like a derived handle.
        const requestedRaw = request.headers.get('x-share-handle') || '';
        const requested = sanitizeNamespace(requestedRaw);
        if (requestedRaw && (!requested || requested.length > 63)) {
          return json({ error: 'invalid handle', handle: requestedRaw }, 400);
        }
        const expected = requested || phoenixHandle(auth);
        if (!expected || segments[0] !== expected) {
          return json({ error: 'namespace mismatch', owner: expected }, 403);
        }
        const claimed = await claimHandle(env.BUCKET, expected, auth.owner, auth.email || '');
        if (claimed.error) return claimed.error;
      }
      const expiresAt = request.headers.get('x-share-expires-at') || '';
      // 'unlisted' hides the page from the public gallery + JSON listing while
      // keeping the direct URL world-readable (capability URL, not secret).
      // me/org are also hidden from gallery/listing; GET is identity-gated
      // and always sends X-Robots-Tag: noindex (same as unlisted).
      const contentType = request.headers.get('content-type') || 'text/html; charset=utf-8';
      // Provenance (RUSH-2683): captured client-side from the exec env/git/clock,
      // never invented here — a header is simply absent when the CLI had nothing
      // to say. --meta entries ride one JSON header; reserved keys are stripped
      // from that JSON UNCONDITIONALLY (not just overwritten when a provenance
      // header happens to be present) so a same-named x-share-meta entry can
      // never smuggle through on a publish that carries no agent/session/host/
      // repo/date at all — e.g. a human publishing outside an agent session, or
      // outside a git checkout.
      // Full-Unicode headers (PHNX-2786): the CLI always sends the latin1-safe
      // x-share-<field> (what a pre-Unicode Worker read), and when the fold was
      // lossy ALSO a percent-encoded x-share-<field>-u companion plus an
      // x-share-encoding: percent opt-in. Prefer the decoded companion when the
      // opt-in is present, so a Japanese/emoji title/label/--meta renders in full
      // instead of (unnamed) or a dropped glyph; a malformed companion falls
      // back to the folded value rather than failing the publish.
      const usePercent = (request.headers.get('x-share-encoding') || '') === 'percent';
      const readText = (name) => {
        const folded = request.headers.get('x-share-' + name) || '';
        if (usePercent) {
          const encoded = request.headers.get('x-share-' + name + '-u');
          if (encoded) {
            try {
              return decodeURIComponent(encoded);
            } catch (e) {
              return folded;
            }
          }
        }
        return folded;
      };
      const agent = readText('agent');
      const session = readText('session');
      const host = readText('host');
      const repo = readText('repo');
      const date = readText('date');
      const avatar = readText('avatar');
      const label = readText('label');
      const ogTitle = readText('og-title');
      const ogDescription = readText('og-description');
      const labelSource = request.headers.get('x-share-label-source') || '';
      let extraMeta = {};
      // The -u meta companion carries the whole raw object percent-encoded, so a
      // single decode+parse recovers full-Unicode keys and values; fall back to
      // the per-value-folded x-share-meta when it is absent or malformed.
      const metaEncoded = usePercent ? request.headers.get('x-share-meta-u') : null;
      if (metaEncoded) {
        try {
          const parsed = JSON.parse(decodeURIComponent(metaEncoded));
          if (parsed && typeof parsed === 'object') extraMeta = parsed;
        } catch (e) {
          // malformed unicode meta companion — fall through to the folded header
        }
      }
      if (!Object.keys(extraMeta).length) {
        const metaHeader = request.headers.get('x-share-meta');
        if (metaHeader) {
          try {
            const parsed = JSON.parse(metaHeader);
            if (parsed && typeof parsed === 'object') extraMeta = parsed;
          } catch {
            // malformed --meta header — ignore rather than fail the whole publish
          }
        }
      }
      const customMetadata = { ...extraMeta };
      // Strip every reserved key UNCONDITIONALLY before re-applying the real
      // provenance below — an if(value)-guarded overwrite alone leaves a
      // same-named --meta entry in place whenever the real header is absent.
      for (const reservedKey of RESERVED_METADATA_KEYS) {
        delete customMetadata[reservedKey];
      }
      if (expiresAt) customMetadata['expires-at'] = expiresAt;
      customMetadata['visibility'] = visibility;
      if (viewerTokenHash) customMetadata['viewer-token-hash'] = viewerTokenHash;
      const owner =
        auth.kind === 'phoenix'
          ? auth.owner
          : (env.SHARE_NAMESPACE || segments[0] || 'byo');
      if (owner) customMetadata['owner'] = owner;
      if (visibility === 'org') customMetadata['org_domain'] = emailDomain(auth.email);
      if (agent) customMetadata['agent'] = agent;
      if (session) customMetadata['session'] = session;
      if (host) customMetadata['host'] = host;
      if (repo) customMetadata['repo'] = repo;
      if (date) customMetadata['date'] = date;
      if (avatar) customMetadata['avatar'] = avatar;
      if (label) customMetadata['label'] = label;
      if (labelSource) customMetadata['label-source'] = labelSource;
      if (ogTitle) customMetadata['og-title'] = ogTitle;
      if (ogDescription) customMetadata['og-description'] = ogDescription;

      // Revision retention (RUSH-2683): R2 has no native object versioning, so a
      // republish over an EXISTING key first copies the current object to
      // <key>/rev-<ts>-<rand> before the canonical key is overwritten. Default
      // keep-all; --no-revision (x-share-no-revision) skips it. The random
      // suffix guards against two rapid overwrites of the same slug colliding on
      // the millisecond, and against a slug whose canonical key already sits 3+
      // segments deep (an unsupported shape outside the CLI) landing on the same
      // literal revision key.
      const noRevision = !!request.headers.get('x-share-no-revision');
      // PHNX-3542: per-user storage quota + object count + per-file size cap +
      // publish rate limit, enforced ONLY for a managed Phoenix identity. A BYO
      // WRITE_TOKEN publish writes to the operator's OWN bucket at their own
      // cost, so it skips all four — a deliberate, documented policy, NOT a
      // silent no-op.
      //
      // Enforcement measures the REAL request body, never a client-declared size.
      // A spoofed-low content-length must NOT (a) slip an oversized body past the
      // per-file cap, (b) let real bytes exceed the total quota, or — most
      // dangerously — (c) reach the destructive revision-copy + canonical
      // overwrite before the size is known and DESTROY the existing page. So for a
      // Phoenix write we buffer the body bounded by the plan's per-file cap and
      // reject on the REAL size BEFORE any write; only then do we copy the
      // revision and store the buffered bytes. BYO streams unbuffered (uncapped,
      // its own bucket) — which also means a BYO body cannot be re-read for a
      // retry, so BYO gets a single conditional attempt below.
      let putBody = request.body;
      let realBytes = 0;
      if (auth.kind === 'phoenix') {
        const limits = planLimits((await readUsage(env, auth.owner)).usage.plan);
        // Fast-reject an HONEST oversized content-length without reading the body.
        // A dishonest (absent or lied-low) length falls through to the bounded
        // read below, which measures the truth.
        const declaredLen = parseInt(request.headers.get('content-length') || '', 10);
        if (Number.isFinite(declaredLen) && declaredLen > limits.maxFileBytes) {
          return json({ error: 'file too large: max ' + limits.maxFileBytes + ' bytes', maxBytes: limits.maxFileBytes, gotBytes: declaredLen }, 413);
        }
        // readBodyBounded aborts the moment it passes the cap, so a chunked/
        // streaming body can never buffer more than the cap (+ one chunk).
        const read = await readBodyBounded(request, limits.maxFileBytes);
        if (read.oversize) {
          return json({ error: 'file too large: max ' + limits.maxFileBytes + ' bytes', maxBytes: limits.maxFileBytes, gotBytes: read.size }, 413);
        }
        realBytes = read.size;
        putBody = read.bytes;
      }

      // Revision retention + quota charge + canonical write as a BOUNDED
      // compare-and-swap loop (PHNX-3547). The old code read the current object,
      // archived it, then overwrote the canonical key UNCONDITIONALLY: two
      // concurrent republishers both archived the same old version and the
      // loser's new body ended up neither canonical nor retained — silently
      // discarded. R2 has no transactions, so each attempt re-reads the canonical
      // object, archives it as a revision, and overwrites ONLY while the etag
      // still matches the read (onlyIf.etagMatches — the same CAS primitive the
      // PATCH path at :513 and the usage ledger already rely on; R2 returns null
      // on the mismatch instead of storing). A conflicted attempt therefore loses
      // nothing: it re-reads the winner's body, archives THAT as the revision on
      // the next attempt, and lands its own body canonical — both writers survive.
      // Phoenix bytes are buffered above, so retrying is safe; the rate counter
      // and object count advance once (attempt 0) and a conflicted re-charge only
      // bills the growth beyond what this request already paid. A BYO stream is
      // consumed by the first attempt, so it gets one conditional try and a 409
      // asking the caller to retry the whole publish.
      const MAX_PUT_ATTEMPTS = 3;
      let chargedAlready = 0;
      let chargedNewCanonical = false;
      let putResult = null;
      for (let attempt = 0; attempt < MAX_PUT_ATTEMPTS; attempt++) {
        // The current object is needed for BOTH the revision copy and the charge
        // math, and even a first/no-revision publish must read before its
        // conditional write so two concurrent creates cannot both report 200.
        const existing = await env.BUCKET.get(path);
        if (auth.kind === 'phoenix') {
          const existingSize = existing && typeof existing.size === 'number' ? existing.size : 0;
          const newCanonical = !existing;
          // Keeping a revision retains the old canonical bytes AND adds the new
          // ones, so storage grows by the full new size. A no-revision or first
          // publish grows by new minus the bytes it replaces (may be negative on a
          // shrink; the ledger clamps at >= 0).
          const charge = (!noRevision && existing) ? realBytes : realBytes - existingSize;
          // Conflict retry: only the growth beyond what this request already
          // paid. Exact accounting under a lost race is impossible without
          // reconciling the bucket; this stays the ledger's documented
          // best-effort, same as its >= 0 clamp.
          const bill = Math.max(0, charge - chargedAlready);
          chargedAlready += bill;
          const chargeNewCanonical = newCanonical && attempt === 0;
          const charged = await chargeShareWrite(env, auth, {
            charge: bill,
            newCanonical: chargeNewCanonical,
            fileBytes: realBytes,
            countRate: attempt === 0,
          });
          if (charged.error) return charged.error; // rejected BEFORE any destructive write
          if (chargeNewCanonical) chargedNewCanonical = true;
        }

        if (!noRevision && existing) {
          const existingHeaders = new Headers();
          if (typeof existing.writeHttpMetadata === 'function') existing.writeHttpMetadata(existingHeaders);
          const existingContentType = existingHeaders.get('content-type');
          const revKey = path + '/rev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          await env.BUCKET.put(revKey, existing.body, {
            httpMetadata: existingContentType ? { contentType: existingContentType } : undefined,
            customMetadata: existing.customMetadata || {},
          });
        }

        const putOpts = { httpMetadata: { contentType }, customMetadata };
        // Existing objects use the bare R2Object#etag for CAS; missing objects
        // use R2's create-only condition so a concurrent first writer wins loud.
        if (existing && existing.etag) putOpts.onlyIf = { etagMatches: existing.etag };
        else putOpts.onlyIf = { etagDoesNotMatch: '*' };
        putResult = await env.BUCKET.put(path, putBody, putOpts);
        if (putResult !== null) break;
        // A failed create-only condition means another first publisher won.
        // Do not turn that loser into a republish: the caller must see the race.
        if (!existing) break;
        if (auth.kind !== 'phoenix') break; // BYO stream is spent — cannot retry
      }
      if (putResult === null) {
        if (auth.kind === 'phoenix') {
          await refundShareWrite(env, auth.owner, {
            refund: chargedAlready,
            freeCanonical: chargedNewCanonical,
          });
        }
        return json({ error: 'publish conflict: another write landed first, retry the publish' }, 409);
      }
      // A managed republish may change the title/description. Invalidate only
      // its generated sibling so the next crawler receives a fresh card; BYO
      // publishes send no OG metadata and keep their explicitly uploaded cover.
      if (ogTitle) await env.BUCKET.delete(path + '.png');
      return json({ ok: true, url: url.origin + '/' + path, expiresAt: expiresAt || null, unlisted: visibility === 'unlisted', visibility }, 200);
    }

    if (request.method === 'PATCH') {
      const auth = await authorizeWrite(request, env);
      if (auth.error) return auth.error;
      const segments = path.split('/').filter(Boolean);
      if (segments.length < 2) return json({ error: 'metadata edit requires /<username>/<slug>' }, 400);
      if (auth.kind === 'phoenix') {
        const expected = phoenixHandle(auth);
        const handle = segments[0];
        if (!expected || handle !== expected) {
          // An alternate handle must already have a claim; unlike PUT, PATCH
          // cannot create a new namespace as a side effect.
          const claim = handle ? await env.BUCKET.get('__handles/' + handle) : null;
          if (!claim) return json({ error: 'namespace mismatch', owner: expected }, 403);
        }
        // Use the same ownership path as PUT/DELETE so the same verified email
        // under a new userId transfers the claim and re-stamps old pages before
        // the per-object ownership check below.
        const owned = await assertHandleOwner(env.BUCKET, handle, auth.owner, auth.email || '');
        if (owned.error) return json({ error: 'forbidden' }, 403);
      }
      const existing = await env.BUCKET.get(path);
      if (!existing) return json({ error: 'share not found', key: path }, 404);
      // Ownership was settled above, the same way DELETE settles it: WRITE_TOKEN
      // is the endpoint owner/admin credential, and a Phoenix caller has proven
      // the handle claim (or, pre-claim, that no rival userId owns the prefix).
      // There is deliberately NO per-object owner comparison here. Pages in a
      // claimed namespace can carry a stamp that is not the claim holder's
      // userId — a BYO WRITE_TOKEN publish stamps owner = the namespace, a page
      // from the same human's earlier userId that transferHandle never saw, or
      // a page with no stamp at all — and the claim holder could DELETE every
      // one of them yet was refused a visibility change (403 'forbidden'), which
      // left confidential pages public with takedown as the only remedy. The
      // claim is the authority. The stamp itself is deliberately NOT rewritten:
      // the anonymous lazy-expiry path refunds the STAMPED owner's usage ledger
      // (see the GET expiry branch + refundShareWrite), and a fleet/BYO page was
      // never charged to a Phoenix ledger — re-stamping it to the caller would
      // credit her quota with bytes and a slot she never paid for on expiry.

      let edit;
      try { edit = await request.json(); } catch { return json({ error: 'PATCH body must be JSON' }, 400); }
      if (!edit || typeof edit !== 'object') return json({ error: 'PATCH body must be an object' }, 400);
      const metadata = { ...(existing.customMetadata || {}) };
      const previousVisibility = metadata.visibility || 'public';
      let visibilityChanged = false;
      if (Object.prototype.hasOwnProperty.call(edit, 'label')) {
        if (edit.label !== null && typeof edit.label !== 'string') return json({ error: 'label must be a string or null' }, 400);
        if (typeof edit.label === 'string' && (edit.label.trim() !== edit.label || !edit.label || edit.label.length > 200)) return json({ error: 'label must be 1-200 trimmed characters' }, 400);
        if (edit.label === null) { delete metadata.label; delete metadata['label-source']; }
        else { metadata.label = edit.label; metadata['label-source'] = 'explicit'; }
      }
      // Visibility is a first-class edit field (like label), not an arbitrary
      // --meta entry — 'visibility' is a RESERVED key, so it can only be changed
      // here, never smuggled through edit.meta. me/org require a Phoenix identity
      // and org additionally requires a private (non-public-inbox) email domain,
      // the SAME gate PUT enforces. This is a metadata-only rewrite: the body is
      // untouched, so no revision is created (identical to a label/meta edit).
      if (Object.prototype.hasOwnProperty.call(edit, 'visibility')) {
        const vis = normalizeVisibility(edit.visibility);
        if (vis.error) return vis.error;
        const visibility = vis.value;
        // 'private' can't be set via the metadata-edit route: token-gating needs a
        // fresh viewer key, which only a full publish mints (PHNX-3654). Re-stamping
        // visibility=private here alone would leave the page gated by a hash that
        // never got stored — inaccessible to everyone. Fail loud.
        if (visibility === 'private') return json({ error: 'visibility private must be set at publish time (share --protected)' }, 400);
        if (visibility === 'me' || visibility === 'org') {
          const phoenixBase = typeof env.PHOENIX_ID_BASE === 'string' ? env.PHOENIX_ID_BASE.replace(/\\/+$/, '') : '';
          if (auth.kind !== 'phoenix' || !phoenixBase) return json({ error: 'visibility me/org requires Phoenix identity' }, 400);
          if (visibility === 'org') {
            const domain = emailDomain(auth.email);
            if (!domain) return json({ error: 'org visibility requires a verified email domain' }, 400);
            if (PUBLIC_INBOX_DOMAINS.indexOf(domain) !== -1) return json({ error: 'org visibility cannot use a public email domain', domain: domain }, 400);
          }
        }
        metadata.visibility = visibility;
        visibilityChanged = visibility !== previousVisibility;
        // org_domain is meaningful only for org — set it there, drop the stale
        // value on any move away from org so it can never gate a later read.
        if (visibility === 'org') metadata.org_domain = emailDomain(auth.email);
        else delete metadata.org_domain;
      }
      const mode = edit.metaMode || 'merge';
      if (mode !== 'merge' && mode !== 'replace') return json({ error: 'metaMode must be merge or replace' }, 400);
      const incoming = edit.meta || {};
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return json({ error: 'meta must be an object' }, 400);
      for (const key in incoming) {
        if (RESERVED_METADATA_KEYS.indexOf(key) !== -1) return json({ error: 'reserved metadata key', key: key }, 400);
        if (!/^[a-z0-9-]{1,64}$/.test(key) || typeof incoming[key] !== 'string') return json({ error: 'invalid metadata entry', key: key }, 400);
      }
      if (mode === 'replace') {
        for (const key in metadata) if (RESERVED_METADATA_KEYS.indexOf(key) === -1) delete metadata[key];
      }
      for (const key in incoming) metadata[key] = incoming[key];
      const remove = edit.removeMeta || [];
      if (!Array.isArray(remove)) return json({ error: 'removeMeta must be an array' }, 400);
      for (const key of remove) {
        if (typeof key !== 'string' || RESERVED_METADATA_KEYS.indexOf(key) !== -1 || !/^[a-z0-9-]{1,64}$/.test(key)) return json({ error: 'invalid removable metadata key', key: key }, 400);
        delete metadata[key];
      }
      if (new TextEncoder().encode(JSON.stringify(extraMetaOf(metadata))).length > 2048) return json({ error: 'metadata exceeds 2048 bytes' }, 400);
      // R2 assigns a fresh uploaded timestamp to every put. Preserve the
      // canonical publication time before this metadata-only rewrite so gallery
      // ordering and list JSON do not pretend the page was republished today.
      if (!metadata['published-at']) metadata['published-at'] = new Date(existing.uploaded).toISOString();
      const httpHeaders = new Headers();
      if (typeof existing.writeHttpMetadata === 'function') existing.writeHttpMetadata(httpHeaders);
      const putOpts = { httpMetadata: httpHeaders, customMetadata: metadata };
      // onlyIf.etagMatches wants the bare hash (R2Object#etag), not the
      // quoted HTTP header form (R2Object#httpEtag) — passing httpEtag 500s
      // on a real Workers R2 binding ("Conditional ETag should not be
      // wrapped in quotes"), a defect only a real R2 backend surfaces.
      if (existing.etag) putOpts.onlyIf = { etagMatches: existing.etag };
      const putResult = await env.BUCKET.put(path, existing.body, putOpts);
      if (putResult === null) return json({ error: 'conflict', key: path }, 409);
      // A generated cover copies the canonical visibility gate into its own R2
      // metadata. Invalidate it after a successful visibility rewrite so the
      // next cover GET re-gates and renders from the canonical page. Explicitly
      // uploaded BYO siblings carry no marker and remain independent assets.
      if (visibilityChanged) {
        const cover = await env.BUCKET.get(path + '.png');
        if (cover && cover.customMetadata && cover.customMetadata['og-generated'] === 'true') {
          await env.BUCKET.delete(path + '.png');
        }
      }
      return json({ ok: true, url: url.origin + '/' + path, label: metadata.label || null, meta: extraMetaOf(metadata), visibility: metadata.visibility || 'public', previousVisibility: previousVisibility }, 200);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      // Single-segment path may be a user gallery/listing OR a legacy flat slug.
      // The disambiguator is whether the <seg>/ prefix holds any object: only a
      // genuine per-user namespace does. BOTH the HTML gallery and the
      // machine-readable listing gate on it, so ?format=json on a legacy flat
      // slug (an object stored at the bare key, before per-user namespaces) does
      // NOT hijack it into a fake empty listing — it falls through to the object
      // GET below and serves its real content, exactly as before.
      const segments = path.split('/').filter(Boolean);
      if (segments.length === 1) {
        const list = await env.BUCKET.list({ prefix: segments[0] + '/', limit: 1 });
        const isNamespace = list.objects && list.objects.length > 0;
        if (isNamespace) {
          if (url.searchParams.get('format') === 'json') {
            const scope = await resolveListingScope(request, env, segments[0]);
            if (scope.error) return scope.error;
            return renderListing(env.BUCKET, url.origin, segments[0], request.method, scope.includeHidden);
          }
          return renderGallery(env.BUCKET, url.origin, segments[0], request.method);
        }
        // Not a namespace: fall through. A legacy flat-slug object resolves to its
        // real content; anything else 404s (an empty/nonexistent namespace, which
        // agents share list reads as "nothing published" via the template-hash
        // signal rather than a missing route).
      }

      // Revision history for one canonical <user>/<slug> key (RUSH-2683). Checked
      // before the plain object GET below so the query param routes even though
      // the canonical key itself resolves to a real object. me/org use the same
      // identity gate as the page GET — listing session/host/repo on an unauthed
      // ?revisions=json must not leak that the page exists.
      if (segments.length === 2 && url.searchParams.get('revisions') === 'json') {
        const canonical = await env.BUCKET.get(path);
        const canonicalVis = canonical ? ((canonical.customMetadata && canonical.customMetadata.visibility) || 'public') : 'public';
        // Only a me/org canonical needs the viewer resolved — and only there does
        // a phoenix_ticket failure gate the response, exactly as before this route
        // shared resolveViewer with the page GET. A public/unlisted revision list
        // never invoked ticket redemption, so a stale ticket must not 401 it.
        if (canonical && isIdentityGated(canonicalVis)) {
          const viewer = await resolveViewer(request, env, url);
          if (viewer.redirect) return viewer.redirect;
          if (viewer.error) return viewer.error;
          const denied = await gateVisibility(url, env, canonical, viewer.identity || null);
          if (denied) return denied;
        }
        // A private canonical gates its revision list on the viewer key too
        // (PHNX-3654) — listing session/host/repo of a token-gated page to an
        // unauthenticated caller would leak the very metadata the gate protects.
        if (canonical && canonicalVis === 'private') {
          const viewer = await resolveViewer(request, env, url);
          if (viewer.redirect) return viewer.redirect;
          const tokenDenied = await gateTokenRead(request, url, canonical, viewer.identity || null);
          if (tokenDenied) return tokenDenied;
        }
        return renderRevisions(
          env.BUCKET,
          url.origin,
          path,
          request.method,
          !!canonical && (isIdentityGated(canonicalVis) || canonicalVis === 'private'),
        );
      }

      // Managed OG cover: generated siblings are caches, never visibility
      // authorities. Gate every request against the current canonical page and
      // bind each cached render to that page's etag. Re-read after rendering and
      // after storing so a concurrent PATCH cannot publish a card from the old
      // visibility/title/description snapshot. Explicit BYO siblings carry no
      // generated marker and continue through the ordinary object route below.
      if (segments.length === 2 && path.endsWith('.png')) {
        let existingCover = await env.BUCKET.get(path);
        if (!existingCover || (existingCover.customMetadata && existingCover.customMetadata['og-generated'] === 'true')) {
          const pagePath = path.slice(0, -4);
          const viewer = await resolveViewer(request, env, url);
          if (viewer.redirect) return viewer.redirect;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const page = await env.BUCKET.get(pagePath);
            if (!page) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
            const pageVisibility = (page.customMetadata && page.customMetadata.visibility) || 'public';
            if (viewer.error && isIdentityGated(pageVisibility)) return viewer.error;
            const denied = await gateVisibility(url, env, page, viewer.identity || null);
            if (denied) return denied;
            // A token-gated page's cover is token-gated too (PHNX-3654): a crawler
            // fetching <slug>.png without the key gets 404, so no preview leaks.
            const coverTokenDenied = await gateTokenRead(request, url, page, viewer.identity || null);
            if (coverTokenDenied) return coverTokenDenied;

            if (existingCover && existingCover.customMetadata['og-source-etag'] === page.etag) {
              const current = await env.BUCKET.get(pagePath);
              if (!current || current.etag !== page.etag) { existingCover = null; continue; }
              const currentDenied = await gateVisibility(url, env, current, viewer.identity || null);
              if (currentDenied) return currentDenied;
              return new Response(request.method === 'HEAD' ? null : existingCover.body, {
                status: 200,
                headers: managedCoverHeaders(pageVisibility),
              });
            }

            const pageHtml = await page.text();
            const meta = page.customMetadata || {};
            let png;
            try {
              png = await hooks.renderOgCard({
                title: meta['og-title'] || extractHtmlMeta(pageHtml, 'title') || meta.label || segments[1],
                description: meta['og-description'] || extractHtmlMeta(pageHtml, 'description') || '',
                handle: segments[0],
                visibility: pageVisibility,
                orgDomain: meta.org_domain || '',
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              return new Response('OG card render failed: ' + detail, {
                status: 500,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              });
            }
            const beforeStore = await env.BUCKET.get(pagePath);
            if (!beforeStore || beforeStore.etag !== page.etag) { existingCover = null; continue; }
            await env.BUCKET.put(path, png, {
              httpMetadata: { contentType: 'image/png' },
              customMetadata: { ...meta, 'og-generated': 'true', 'og-source-etag': page.etag },
            });
            const beforeServe = await env.BUCKET.get(pagePath);
            if (!beforeServe || beforeServe.etag !== page.etag) {
              const justStored = await env.BUCKET.get(path);
              if (justStored && justStored.customMetadata && justStored.customMetadata['og-source-etag'] === page.etag) {
                await env.BUCKET.delete(path);
              }
              existingCover = null;
              continue;
            }
            return new Response(request.method === 'HEAD' ? null : png, {
              status: 200,
              headers: managedCoverHeaders(pageVisibility),
            });
          }
          return new Response('cover changed during rendering; retry', { status: 503, headers: { 'content-type': 'text/plain', 'retry-after': '1' } });
        }
      }

      const obj = await env.BUCKET.get(path);
      if (!obj) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      const expiresAt = obj.customMetadata && obj.customMetadata['expires-at'];
      if (expiresAt && Date.now() > Date.parse(expiresAt)) {
        await env.BUCKET.delete(path);
        // PHNX-3542: expiry is a lazy delete with no auth context. Refund the
        // stamped owner's quota (bytes + object count) best-effort — a refund
        // failure must never break serving the 410. A canonical page is 2
        // segments; covers are excluded (never charged) so refund is safe here
        // because only canonical pages ever carry an expires-at.
        const expiredOwner = obj.customMetadata && obj.customMetadata['owner'];
        if (expiredOwner && !path.endsWith('.png')) {
          try {
            await refundShareWrite(env, expiredOwner, {
              refund: typeof obj.size === 'number' ? obj.size : 0,
              freeCanonical: path.split('/').filter(Boolean).length === 2,
            });
          } catch (e) {
            // best-effort: serving the expiry 410 must never depend on the refund
          }
        }
        return new Response('gone — this link has expired', { status: 410, headers: { 'content-type': 'text/plain' } });
      }
      // Resolve the viewer ONCE — needed both to gate me/org reads AND to decide
      // whether THIS viewer OWNS this namespace (the interactive visibility
      // control below). A successful phoenix_ticket redemption (redirect: set the
      // identity cookie, strip the ticket) is honored on ANY page. But a ticket
      // FAILURE (expired/consumed/unreachable) must only gate a page that needs
      // identity — a public/unlisted page never invoked ticket redemption before
      // this refactor, so a stale ticket there must serve anonymously, not 401.
      const visibility = (obj.customMetadata && obj.customMetadata.visibility) || 'public';
      const viewer = await resolveViewer(request, env, url);
      if (viewer.redirect) return viewer.redirect;
      if (viewer.error && isIdentityGated(visibility)) return viewer.error;
      const identity = viewer.identity || null;
      const denied = await gateVisibility(url, env, obj, identity);
      if (denied) return denied;
      // Token-gated read auth (PHNX-3654): a 'private' page is served only to a
      // request carrying the matching viewer key (?k= or Bearer), or to its owner.
      // A miss returns 404 — never leaking that the page exists — exactly like a
      // wrong me/org viewer.
      const tokenDenied = await gateTokenRead(request, url, obj, identity);
      if (tokenDenied) return tokenDenied;
      // The owner of the namespace (their handle === the first path segment) gets
      // an interactive visibility control; everyone else keeps the static cue.
      const isOwner = !!identity && handleFromEmail(identity.email) === firstSeg;
      const ownerDomain = identity ? emailDomain(identity.email) : '';
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8');
      if (visibility === 'me' || visibility === 'org' || visibility === 'private') {
        // Token-gated + identity-gated reads must never be cached by a shared
        // proxy, and never indexed.
        headers.set('cache-control', 'private, no-store');
        headers.set('X-Robots-Tag', 'noindex');
      } else {
        headers.set('cache-control', 'public, max-age=60');
        if (visibility === 'unlisted') headers.set('X-Robots-Tag', 'noindex');
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      const ctype = headers.get('content-type') || '';
      // HTML pages ALWAYS get the attribution bar injected at serve time (who
      // shared it, what made it, when, and — the point — a visual VISIBILITY cue),
      // all from stamped metadata. This is unconditional: ?raw does NOT strip the
      // bar from a shared page (the always-on cue from #3122/#3140 is not
      // defeatable with a query param). The body changes, so the R2 etag no
      // longer matches — drop it rather than serve a lying validator.
      if (ctype.indexOf('text/html') !== -1) {
        const rawHtml = await obj.text();
        // Per-slug view counter (RUSH view stats). Stored as a SEPARATE R2 object
        // (__views/<path>) so it never rewrites the page object — a rewrite would
        // reset obj.uploaded and corrupt "last updated". The __-prefix key is GET-
        // blocked for direct requests and lives outside every <user>/ list prefix,
        // so it never leaks into the gallery/listing/revisions. Count only a real
        // visitor's page view: not ?raw (an embed/OG fetch), not the owner's own
        // view, and never HEAD (which returned above). The write rides
        // ctx.waitUntil so it never blocks the response; the displayed count folds
        // in the current view so the visitor sees themselves included.
        const wantsRaw = url.searchParams.get('raw') != null;
        const counting = !wantsRaw && !isOwner;
        const storedViews = await readViews(env, path);
        const views = storedViews + (counting ? 1 : 0);
        if (counting && ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(writeViews(env, path, views));
        }
        const withBar = injectAttributionBar(rawHtml, obj.customMetadata || {}, firstSeg, {
          isOwner,
          ownerDomain,
          views,
          uploaded: obj.uploaded,
        });
        headers.delete('etag');
        return new Response(withBar, { status: 200, headers });
      }
      // Non-HTML asset. ?raw returns the stored bytes untouched — the escape hatch
      // for <img src>, OG crawlers, iframes, and anyone embedding the asset (the
      // viewer's own media element points back at ?raw). Otherwise a BROWSER
      // navigating directly to a viewable asset (image/video/audio/pdf) gets a
      // lightweight viewer page carrying the same bar; a non-browser fetch (Accept
      // without text/html) falls through to raw bytes so embedding is never broken.
      const wantsRaw = url.searchParams.get('raw') != null;
      const kind = viewableAssetKind(ctype);
      // A token-gated (private) asset is served as raw bytes, NOT wrapped in the
      // viewer page (PHNX-3654): the viewer's inner <img src=…?raw> would drop the
      // ?k= key and 404 (there's no cookie to carry it, unlike me/org), breaking the
      // media. The gate already passed above, so the raw bytes are safe to serve.
      if (!wantsRaw && kind && acceptsHtml(request) && visibility !== 'private') {
        const viewerPage = renderAssetViewer(url.pathname, kind, obj.customMetadata || {}, firstSeg, {
          isOwner,
          ownerDomain,
        });
        const vheaders = new Headers(headers);
        vheaders.set('content-type', 'text/html; charset=utf-8');
        vheaders.delete('etag');
        return new Response(viewerPage, { status: 200, headers: vheaders });
      }
      return new Response(obj.body, { status: 200, headers });
    }

    if (request.method === 'DELETE') {
      const auth = await authorizeWrite(request, env);
      if (auth.error) return auth.error;
      if (auth.kind === 'phoenix') {
        const handle = phoenixHandle(auth);
        const uid = sanitizeNamespace(auth.owner);
        const delSegments = path.split('/').filter(Boolean);
        // Handle is the public namespace; userId prefix is still deletable so
        // P1 UUID-namespaced objects the same account published can be taken down.
        // A colliding local-part (same handle, different userId) must not be
        // able to DELETE the claimant's pages — consult the claim the same way PUT does.
        if (delSegments[0] && delSegments[0] === uid) {
          // own leftover UUID prefix
        } else if (delSegments[0] && delSegments[0] === handle) {
          const owned = await assertHandleOwner(env.BUCKET, handle, auth.owner, auth.email || '');
          if (owned.error) return owned.error;
        } else if (delSegments[0]) {
          // An explicitly-chosen handle (the CLI's --handle, PHNX-3547): the
          // caller's derived handle differs from the namespace, so the claim is
          // the authority — assertHandleOwner refuses strangers (409) and
          // recovers a same-email account move. No claim at all is a mismatch.
          const claim = await env.BUCKET.get('__handles/' + delSegments[0]);
          if (!claim) return json({ error: 'namespace mismatch', owner: handle || uid }, 403);
          const owned = await assertHandleOwner(env.BUCKET, delSegments[0], auth.owner, auth.email || '');
          if (owned.error) return owned.error;
        } else {
          return json({ error: 'namespace mismatch', owner: handle || uid }, 403);
        }
      }
      // PHNX-3542: capture the object's size BEFORE deleting so a managed
      // Phoenix owner's quota can be refunded. A canonical page (2 segments, not
      // a .png cover) refunds both bytes and the object count; a retained
      // revision (3+ segments) refunds bytes only; a server-generated .png cover
      // was never charged, so it is skipped entirely.
      let doomed = null;
      const isCover = path.endsWith('.png');
      if (auth.kind === 'phoenix' && !isCover && !firstSeg.startsWith('__')) {
        doomed = typeof env.BUCKET.head === 'function' ? await env.BUCKET.head(path) : await env.BUCKET.get(path);
      }
      await env.BUCKET.delete(path);
      if (doomed) {
        const delSegs = path.split('/').filter(Boolean);
        await refundShareWrite(env, auth.owner, {
          refund: typeof doomed.size === 'number' ? doomed.size : 0,
          freeCanonical: delSegs.length === 2,
        });
      }
      // PHNX-3835: best-effort purge of the deleted share's collaboration
      // threads. Object-first gating already makes comments inaccessible the
      // instant the R2 object is gone (every /__collab request 404s on the
      // missing object), so this is durable cleanup on the Prix side, never the
      // security boundary. Fire-and-forget so a purge failure never fails the
      // delete. Only a managed (Phoenix) canonical page (2 segments, not a
      // cover, not an internal __-key) can carry collaboration.
      const collabCfgDel = collabConfig(env);
      if (
        collabCfgDel &&
        auth.kind === 'phoenix' &&
        !isCover &&
        !firstSeg.startsWith('__') &&
        path.split('/').filter(Boolean).length === 2
      ) {
        const purgeOwner = (doomed && doomed.customMetadata && doomed.customMetadata.owner) || auth.owner;
        const purge = purgeCollab(env, collabCfgDel, purgeOwner, path);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(purge);
        else await purge;
      }
      return json({ ok: true, deleted: path }, 200);
    }

    return new Response('method not allowed', { status: 405 });
  },
};

// A canonical share object's key is exactly 2 segments (<user>/<slug>, or the
// sibling <user>/<slug>.png OG cover). A retained revision lives a 3rd segment
// deeper (<user>/<slug>/rev-<ts>-<rand>) — history, not a page in its own
// right, so every gallery/listing view hides it. A raw external PUT to an
// already-3-segment-deep path is treated the same way for the same reason:
// there is no ambiguity to resolve, and the CLI never produces such a key.
function isRevisionKey(key) {
  return key.split('/').length > 2;
}

function publishedAtOf(object) {
  return (object.customMetadata && object.customMetadata['published-at']) || object.uploaded;
}

async function renderGallery(bucket, origin, user, method) {
  const objects = [];
  let cursor;
  do {
    const list = await bucket.list({ prefix: user + '/', limit: 1000, cursor, include: ['customMetadata'] });
    objects.push(...(list.objects || []));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  const activeObjects = objects.filter(o => {
    if (isRevisionKey(o.key)) return false;
    if (o.key.endsWith('.png')) return false;
    // Unlisted / me / org pages are reachable by direct URL only — never on the gallery.
    if (isHiddenFromGallery(o.customMetadata && o.customMetadata.visibility)) return false;
    const expiresAt = o.customMetadata && o.customMetadata['expires-at'];
    return !(expiresAt && Date.now() > Date.parse(expiresAt));
  });
  const items = activeObjects.map(o => {
    const slug = o.key.slice(o.key.indexOf('/') + 1);
    const url = origin + '/' + o.key;
    const label = (o.customMetadata && o.customMetadata['label']) || '';
    const agent = (o.customMetadata && o.customMetadata['agent']) || '';
    return { slug, url, updated: publishedAtOf(o), label, agent };
  });

  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  const html =
    '<!doctype html><html><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(user) + ' — agents share</title>' +
    '<style>' +
    'body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;color:#111;background:#fafafa}' +
    'h1{font-size:28px;margin-bottom:8px}a{color:#0a0a0a;text-decoration:none;border-bottom:1px solid #999}' +
    'a:hover{border-color:#111}ul{list-style:none;padding:0}li{margin:16px 0}' +
    '.slug{font-weight:600}.title{font-weight:600}.meta{color:#666;font-size:14px}' +
    '</style></head><body>' +
    '<h1>@' + escapeHtml(user) + '</h1>' +
    '<p class="meta">' + items.length + ' shared ' + (items.length === 1 ? 'page' : 'pages') + '</p>' +
    '<ul>' +
    items.map(i =>
      '<li>' +
      (i.label ? '<span class="title">' + escapeHtml(i.label) + '</span><br>' : '') +
      '<a class="slug" href="' + escapeHtml(i.url) + '">' + escapeHtml(i.slug) + '</a>' +
      '<br><span class="meta">' + new Date(i.updated).toISOString().slice(0, 10) +
      (i.agent ? ' · ' + escapeHtml(i.agent) : '') + '</span></li>'
    ).join('') +
    '</ul></body></html>';
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } });
}

async function renderListing(bucket, origin, user, method, includeHidden) {
  const objects = [];
  let cursor;
  do {
    const list = await bucket.list({ prefix: user + '/', limit: 1000, cursor, include: ['httpMetadata', 'customMetadata'] });
    objects.push(...(list.objects || []));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  // Revisions never appear as their own listing row, but they count toward
  // their canonical object's revisionCount.
  const revisionCounts = {};
  for (const o of objects) {
    if (!isRevisionKey(o.key)) continue;
    const canonicalKey = o.key.split('/').slice(0, 2).join('/');
    revisionCounts[canonicalKey] = (revisionCounts[canonicalKey] || 0) + 1;
  }

  const now = Date.now();
  const items = objects
    .filter(o => {
      // Revisions and sibling .png OG covers are always hidden. Hidden-visibility
      // pages are included ONLY when an authenticated owner requested scope=mine.
      if (isRevisionKey(o.key)) return false;
      if (o.key.endsWith('.png')) return false;
      if (isHiddenFromGallery(o.customMetadata && o.customMetadata.visibility) && !includeHidden) return false;
      const expiresAt = o.customMetadata && o.customMetadata['expires-at'];
      return !(expiresAt && now > Date.parse(expiresAt));
    })
    .map(o => ({
      slug: o.key.slice(o.key.indexOf('/') + 1),
      url: origin + '/' + o.key,
      size: typeof o.size === 'number' ? o.size : 0,
      contentType: (o.httpMetadata && o.httpMetadata.contentType) || null,
      publishedAt: new Date(publishedAtOf(o)).toISOString(),
      expiresAt: (o.customMetadata && o.customMetadata['expires-at']) || null,
      label: (o.customMetadata && o.customMetadata['label']) || null,
      visibility: (o.customMetadata && o.customMetadata.visibility) || 'public',
      agent: (o.customMetadata && o.customMetadata['agent']) || null,
      session: (o.customMetadata && o.customMetadata['session']) || null,
      host: (o.customMetadata && o.customMetadata['host']) || null,
      repo: (o.customMetadata && o.customMetadata['repo']) || null,
      revisionCount: revisionCounts[o.key] || 0,
      meta: extraMetaOf(o.customMetadata),
    }));
  // Newest first, so the human table and any script reads the freshest share top.
  items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));

  const cacheHeaders = includeHidden
    ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'X-Robots-Tag': 'noindex' }
    : { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' };
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: cacheHeaders });
  }
  return new Response(JSON.stringify({ user, count: items.length, objects: items }), {
    status: 200,
    headers: cacheHeaders,
  });
}

// The machine-readable listing is public by default. A request with
// '?format=json&scope=mine' asks to include the owner's hidden pages
// (unlisted / me / org). We honor it ONLY after a valid owner bearer whose
// namespace matches the requested handle, so one user cannot list another's
// hidden shares. Anonymous or mismatched requests fail loud. A BYO WRITE_TOKEN
// bearer is the worker's owner, so namespace enforcement is skipped for BYO.
async function resolveListingScope(request, env, user) {
  const scope = new URL(request.url).searchParams.get('scope');
  if (scope !== 'mine') return { includeHidden: false };
  const auth = await authorizeWrite(request, env);
  if (auth.error) return { error: auth.error };
  if (auth.kind === 'byo') {
    return { includeHidden: true };
  }
  const owner = phoenixHandle(auth);
  if (owner !== user) {
    return { error: json({ error: 'namespace mismatch' }, 403) };
  }
  return { includeHidden: true };
}

async function renderRevisions(bucket, origin, key, method, identityGated) {
  const objects = [];
  let cursor;
  do {
    const list = await bucket.list({ prefix: key + '/rev-', limit: 1000, cursor, include: ['httpMetadata', 'customMetadata'] });
    objects.push(...(list.objects || []));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  const items = objects.map(o => ({
    key: o.key,
    url: origin + '/' + o.key,
    size: typeof o.size === 'number' ? o.size : 0,
    contentType: (o.httpMetadata && o.httpMetadata.contentType) || null,
    uploadedAt: new Date(o.uploaded).toISOString(),
    expiresAt: (o.customMetadata && o.customMetadata['expires-at']) || null,
    label: (o.customMetadata && o.customMetadata['label']) || null,
    agent: (o.customMetadata && o.customMetadata['agent']) || null,
    session: (o.customMetadata && o.customMetadata['session']) || null,
    host: (o.customMetadata && o.customMetadata['host']) || null,
    repo: (o.customMetadata && o.customMetadata['repo']) || null,
    meta: extraMetaOf(o.customMetadata),
  }));
  // Newest first — the most recently replaced version leads.
  items.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));

  const cacheHeaders = identityGated
    ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'X-Robots-Tag': 'noindex' }
    : { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' };
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: cacheHeaders });
  }
  return new Response(JSON.stringify({ key, count: items.length, revisions: items }), {
    status: 200,
    headers: cacheHeaders,
  });
}

// The customMetadata keys the CLI sets automatically (provenance + label) —
// never a real \`--meta key=value\` entry (the CLI rejects a colliding key
// before it ever reaches this Worker; see RESERVED_META_KEYS in publish.ts).
// One list, reused both to strip a same-named --meta collision on write and
// to split arbitrary --meta entries back out on read.
var RESERVED_METADATA_KEYS = ['expires-at', 'published-at', 'visibility', 'viewer-token-hash', 'owner', 'org_domain', 'agent', 'session', 'host', 'repo', 'date', 'avatar', 'label', 'label-source', 'og-title', 'og-description', 'og-generated', 'og-source-etag'];
var PUBLIC_INBOX_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com'];
var SHARE_COOKIE = '__Host-phoenix_share';
var SHARE_COOKIE_MAX_AGE = 604800;

// PHNX-3542 — per-user storage limits for the MANAGED share endpoint. The plan
// map is the seam for future paid tiers: only 'free' is defined today, and a
// ledger with no plan (or an unknown one) resolves to it via planLimits(). Paid
// tiers and the write path that sets a user's plan arrive with billing (follow-up
// PHNX-3569); this is a legitimately-deferred seam, not a stub — 'free' IS
// enforced. Covers/views are server-generated overhead and excluded from the
// quota, which counts canonical pages + their retained revisions only.
var MiB = 1024 * 1024;
var SHARE_PLANS = {
  free: { maxBytes: 200 * MiB, maxObjects: 150, maxFileBytes: 20 * MiB, ratePerHour: 60 },
};
var DEFAULT_SHARE_PLAN = 'free';
var RATE_WINDOW_MS = 3600 * 1000; // fixed 1h publish-rate window
function planLimits(plan) { return SHARE_PLANS[plan] || SHARE_PLANS[DEFAULT_SHARE_PLAN]; }
function freshUsage() { return { bytes: 0, count: 0, plan: DEFAULT_SHARE_PLAN, rlStart: 0, rlUsed: 0 }; }
function usageNumber(v, fallback) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback; }

// Everything in customMetadata that ISN'T one of the reserved provenance/label
// keys above — i.e. the caller's own \`--meta key=value\` entries. Surfaced on
// every read route (listing, revisions) so a value stored with \`--meta
// kind=plan --meta ticket=RUSH-2683\` is actually visible again, not just
// write-only (RUSH-2683 review fix).
function extraMetaOf(customMetadata) {
  var out = {};
  if (!customMetadata) return out;
  for (var k in customMetadata) {
    if (RESERVED_METADATA_KEYS.indexOf(k) === -1) out[k] = customMetadata[k];
  }
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The attribution bar: a slim strip prepended to every served HTML page that
// makes the object's stamped metadata visible — who shared it, what made it,
// when, and (the whole point) a color-coded VISIBILITY cue Google-Drive style.
// All values come from customMetadata; nothing new is stamped at publish time,
// so this is a pure Worker change deployable with 'agents artifacts share update'.
var VIS_ICON = {
  me: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  org: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M6 21V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v17M14 9h4a1 1 0 0 1 1 1v11"/></svg>',
  unlisted: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  public: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
};

// Eye glyph for the view-count stat; caret for the owner's interactive chip.
var STAT_EYE_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
var CARET_ICON = '<svg class="ash-caret" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg>';

// The owner-only browser script that turns the visibility chip into a live
// control. Self-contained IIFE, namespaced under .agents-share-bar; injected only
// when the viewer owns the namespace. It reads the current level and each level's
// icon/color/label straight from the rendered menu DOM (no embedded config), then
// PATCHes the SAME in-place edit route the CLI uses — method PATCH, JSON body
// { visibility } — with credentials:'include' so the viewer's __share cookie /
// Phoenix identity rides. Optimistic: flip the chip + spinner, then a green check
// on 2xx or revert + the server's error text on failure (an org-on-public-inbox
// 400 surfaces verbatim). The share page sets no CSP, so inline JS is fine.
var ASH_OWNER_JS = \`(function(){
  var root = document.querySelector('.agents-share-bar');
  if(!root) return;
  var chip = root.querySelector('[data-ash-chip]');
  var menu = root.querySelector('[data-ash-menu]');
  var toast = root.querySelector('[data-ash-toast]');
  if(!chip || !menu || !toast) return;
  var labelEl = chip.querySelector('[data-ash-label]');
  var chipIc = chip.querySelector('[data-ash-chip-ic]');
  var busy = false;
  function opts(){ return menu.querySelectorAll('[data-ash-opt]'); }
  function currentKey(){ var s = menu.querySelector('.ash-opt.ash-sel'); return s ? s.getAttribute('data-ash-opt') : ''; }
  function labelFor(key){ var a = opts(); for(var i=0;i<a.length;i++){ if(a[i].getAttribute('data-ash-opt')===key){ var b = a[i].querySelector('b'); return b ? b.textContent : key; } } return key; }
  function open(){ menu.classList.add('ash-open'); menu.setAttribute('aria-hidden','false'); }
  function close(){ menu.classList.remove('ash-open'); menu.setAttribute('aria-hidden','true'); }
  chip.addEventListener('click', function(e){ e.stopPropagation(); if(menu.classList.contains('ash-open')) close(); else open(); });
  menu.addEventListener('click', function(e){ e.stopPropagation(); });
  document.addEventListener('click', close);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
  function draw(key){
    var sel = null, a = opts();
    for(var i=0;i<a.length;i++){ var on = a[i].getAttribute('data-ash-opt')===key; a[i].classList.toggle('ash-sel', on); if(on) sel = a[i]; }
    if(!sel) return;
    var ic = sel.querySelector('.ash-opt-ic');
    var color = ic ? ic.style.color : '';
    if(color){ chip.style.color = color; chip.style.borderColor = color + '66'; }
    if(chipIc && ic) chipIc.innerHTML = ic.innerHTML;
    var b = sel.querySelector('b');
    if(labelEl && b) labelEl.textContent = b.textContent;
  }
  function say(inner, cls){ toast.innerHTML = inner; toast.className = 'ash-toast ash-show' + (cls ? ' ' + cls : ''); }
  function fade(ms){ setTimeout(function(){ toast.className = 'ash-toast'; }, ms); }
  function pick(key){
    close();
    var prev = currentKey();
    if(busy || !key || key===prev) return;
    busy = true;
    draw(key);
    var name = labelFor(key);
    say('<span class="ash-spin"></span> Saving…');
    fetch(location.pathname, { method:'PATCH', credentials:'include', headers:{'content-type':'application/json'}, body: JSON.stringify({ visibility: key }) })
      .then(function(res){ return res.json().then(function(j){ return { ok: res.ok, status: res.status, body: j }; }, function(){ return { ok: res.ok, status: res.status, body: {} }; }); })
      .then(function(r){
        busy = false;
        if(r.ok){ say('<span class="ash-ok">\\u2713</span> Now ' + name, 'ash-good'); fade(1600); }
        else {
          draw(prev);
          var msg = (r.body && r.body.error) ? String(r.body.error) : ('Could not update (HTTP ' + r.status + ')');
          say('<span class="ash-err">\\u2715</span> ' + msg.replace(/[<>&]/g, ' '), 'ash-bad');
          fade(4000);
        }
      }, function(){ busy = false; draw(prev); say('<span class="ash-err">\\u2715</span> Network error \\u2014 not saved', 'ash-bad'); fade(4000); });
  }
  var a = opts();
  for(var i=0;i<a.length;i++){ (function(el){ el.addEventListener('click', function(e){ e.stopPropagation(); pick(el.getAttribute('data-ash-opt')); }); })(a[i]); }
})();\`;

function visibilityChip(visibility, orgDomain) {
  if (visibility === 'me') return { icon: VIS_ICON.me, label: 'Only you', color: '#f59e0b' };
  if (visibility === 'org') return { icon: VIS_ICON.org, label: 'Anyone at ' + escapeHtml(orgDomain || 'your organization'), color: '#5b9dff' };
  if (visibility === 'private') return { icon: VIS_ICON.me, label: 'Protected (link + key)', color: '#f59e0b' };
  if (visibility === 'unlisted') return { icon: VIS_ICON.unlisted, label: 'Unlisted', color: '#9aa0a6' };
  return { icon: VIS_ICON.public, label: 'Public', color: '#30a46c' };
}

// A deterministic hue (0-359) from the handle, so a given sharer always gets the
// same initials-circle colour without any stored palette.
function avatarHue(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// The avatar slot is ALWAYS rendered: a coloured initials circle derived from the
// handle. When the object carries an avatar URL (a Gravatar the CLI stamps at
// publish, or any future hosted photo), a real img is layered on top; onerror
// removes it so the initials underneath show through when the photo 404s. There
// is no CSP on the share page, so the inline onerror fallback is honoured.
function renderAvatar(handle, avatarUrl) {
  var h = (handle || '').trim();
  var initial = escapeHtml((h.charAt(0) || '?').toUpperCase());
  var bg = 'hsl(' + avatarHue(h) + ',48%,42%)';
  var inner = '<span class="ash-av-i">' + initial + '</span>';
  if (avatarUrl) {
    inner += '<img class="ash-av-img" src="' + escapeHtml(avatarUrl) + '" alt="" loading="lazy" ' +
      'referrerpolicy="no-referrer" onerror="this.remove()">';
  }
  return '<span class="ash-avatar" style="background:' + bg + ' !important" aria-hidden="true">' + inner + '</span>';
}

// A compact relative time for the "last updated" stat: "just now", "2h ago",
// "3d ago", or an ISO date once past ~30 days. Accepts a Date or a parseable
// string (R2's obj.uploaded is a Date).
function relativeTime(when) {
  var then = when instanceof Date ? when.getTime() : Date.parse(when);
  if (!then || isNaN(then)) return '';
  var diff = Date.now() - then;
  if (diff < 0) diff = 0;
  var minute = 60000, hour = 3600000, day = 86400000;
  if (diff < minute) return 'just now';
  if (diff < hour) return Math.floor(diff / minute) + 'm ago';
  if (diff < day) return Math.floor(diff / hour) + 'h ago';
  if (diff < 30 * day) return Math.floor(diff / day) + 'd ago';
  return new Date(then).toISOString().slice(0, 10);
}

// The four visibility levels the owner can pick, in menu order. Descriptions
// mirror the approved mockup. org always appears — a public-inbox owner still
// sees it and lets the server's 400 drive the failure message (never a hidden
// client-side rule). orgDomain is the owner's own email domain when known.
function visibilityLevels(orgDomain) {
  return [
    { key: 'public', label: 'Public', color: '#30a46c', icon: VIS_ICON.public, desc: 'Anyone with the link · preview card · listed in your gallery' },
    { key: 'unlisted', label: 'Unlisted', color: '#9aa0a6', icon: VIS_ICON.unlisted, desc: 'Anyone with the link · no card · hidden from your gallery' },
    { key: 'me', label: 'Only you', color: '#f59e0b', icon: VIS_ICON.me, desc: 'Sign-in required · only your account can open it' },
    { key: 'org', label: 'Anyone at ' + escapeHtml(orgDomain || 'your org'), color: '#5b9dff', icon: VIS_ICON.org, desc: 'Anyone signed in with a ' + escapeHtml(orgDomain || 'workspace-domain') + ' account' },
  ];
}

function renderVisibilityMenu(current, orgDomain) {
  var rows = visibilityLevels(orgDomain).map(function (l) {
    return '<button type="button" class="ash-opt' + (l.key === current ? ' ash-sel' : '') + '" data-ash-opt="' + l.key + '" role="menuitemradio" aria-checked="' + (l.key === current ? 'true' : 'false') + '">' +
      '<span class="ash-opt-ic" style="color:' + l.color + '">' + l.icon + '</span>' +
      '<span class="ash-opt-t"><b>' + l.label + '</b><span>' + l.desc + '</span></span>' +
      '<span class="ash-rd"></span></button>';
  }).join('');
  return '<div class="ash-menu" data-ash-menu role="menu" aria-hidden="true"><h4>Who can see this</h4>' + rows + '</div>';
}

function renderOwnerScript() {
  return '<script>' + ASH_OWNER_JS + '</script>';
}

// opts: { isOwner, ownerDomain, views, uploaded } — all optional. isOwner turns
// the visibility chip into a live control (inline dropdown, Variation A) and
// injects the owner-only CSS/JS; views/uploaded render the right-side stats
// cluster. With no opts the bar is exactly today's static strip.
function renderAttributionBar(meta, handle, opts) {
  var o = opts || {};
  var cm = meta || {};
  var visibility = cm.visibility || 'public';
  var chip = visibilityChip(visibility, cm.org_domain);
  var avatar = renderAvatar(handle, cm.avatar);
  var left = '';
  // The handle is already the public URL namespace, so surfacing it leaks nothing new.
  if (handle) left += 'Shared by <strong>' + escapeHtml(handle) + '</strong>';
  if (cm.agent) left += (left ? '<span class="ash-dot">·</span>' : '') + 'Made with ' + escapeHtml(cm.agent);

  // Stats cluster (👁 <n> views · updated <rel>) — right side, left of the chip.
  var stats = '';
  var statBits = '';
  if (o.views != null) {
    statBits += STAT_EYE_ICON + '<b>' + escapeHtml(String(o.views)) + '</b> ' + (Number(o.views) === 1 ? 'view' : 'views');
  }
  if (o.uploaded) {
    var rel = relativeTime(o.uploaded);
    if (rel) statBits += (statBits ? '<span class="ash-statsep">·</span>' : '') + 'updated <b>' + escapeHtml(rel) + '</b>';
  }
  if (statBits) stats = '<span class="ash-stats" title="page stats">' + statBits + '</span>';

  // The visibility chip: an interactive control for the owner, a static cue for
  // everyone else (unchanged from today).
  var chipHtml;
  var menu = '';
  var script = '';
  if (o.isOwner) {
    chipHtml = '<span class="ash-chip ash-chip-own" data-ash-chip tabindex="0" role="button" aria-haspopup="menu" ' +
      'style="color:' + chip.color + ';border-color:' + chip.color + '66">' +
      '<span data-ash-chip-ic>' + chip.icon + '</span><span data-ash-label>' + chip.label + '</span>' + CARET_ICON + '</span>';
    menu = renderVisibilityMenu(visibility, o.ownerDomain);
    script = renderOwnerScript();
  } else {
    chipHtml = '<span class="ash-chip" style="color:' + chip.color + ';border-color:' + chip.color + '66">' + chip.icon + '<span>' + chip.label + '</span></span>';
  }

  var right = stats + chipHtml;
  if (cm.date) right += '<span class="ash-date">' + escapeHtml(cm.date) + '</span>';
  // The load-bearing background + base colour ride an INLINE style so the host
  // page's own CSS can never wash the bar out (inline beats a page stylesheet);
  // the rest is a namespaced style block with !important on every colour so a
  // broad page rule (span selector to black, etc.) cannot make the text vanish.
  // FIXED, full-viewport-width chrome (not sticky-inside-body — that inherited the
  // page's max-width/margins and rendered as a floating box). html padding-top
  // pushes the whole page down by the bar's height; flex-wrap:nowrap + ellipsis on
  // the left keeps the bar exactly one line tall so the push height stays correct.
  return '<div class="agents-share-bar" role="contentinfo" aria-label="Sharing details" ' +
    'style="background:#0b0b0c !important;color:#e8e8e8 !important">' +
    '<style>' +
    'html{padding-top:38px !important}' +
    '.agents-share-bar{all:initial;position:fixed !important;top:0 !important;left:0 !important;right:0 !important;width:100% !important;z-index:2147483647 !important;box-sizing:border-box;display:flex !important;align-items:center;gap:12px;flex-wrap:nowrap;' +
    'padding:8px 16px !important;background:#0b0b0c !important;color:#e8e8e8 !important;border-bottom:1px solid #23232a !important;box-shadow:0 1px 3px rgba(0,0,0,.35) !important;' +
    'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif !important}' +
    '.agents-share-bar *{box-sizing:border-box;font-family:inherit}' +
    '.agents-share-bar .ash-avatar{flex:none;position:relative;width:26px;height:26px;border-radius:50% !important;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;color:#fff !important;font-weight:600;font-size:12px;line-height:1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}' +
    '.agents-share-bar .ash-av-i{color:#fff !important}' +
    '.agents-share-bar .ash-av-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50% !important}' +
    '.agents-share-bar .ash-left{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#cfd3d9 !important}' +
    '.agents-share-bar strong{color:#fff !important;font-weight:600}' +
    '.agents-share-bar .ash-dot{opacity:.4;margin:0 4px}' +
    '.agents-share-bar .ash-right{flex:none;display:flex;align-items:center;gap:12px}' +
    '.agents-share-bar .ash-date{color:#9096a0 !important}' +
    '.agents-share-bar .ash-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid;font-weight:600;font-size:12px;white-space:nowrap}' +
    '.agents-share-bar .ash-chip svg{flex:none;vertical-align:middle}' +
    '.agents-share-bar .ash-stats{display:inline-flex;align-items:center;gap:5px;color:#9aa0a6 !important;font-size:12px;white-space:nowrap}' +
    '.agents-share-bar .ash-stats b{color:#c9ced6 !important;font-weight:600}' +
    '.agents-share-bar .ash-stats svg{flex:none;opacity:.85}' +
    '.agents-share-bar .ash-statsep{opacity:.35;margin:0 3px}' +
    (o.isOwner ? OWNER_BAR_CSS : '') +
    '</style>' +
    avatar +
    '<span class="ash-left">' + left + '</span>' +
    '<span class="ash-right">' + right + '</span>' +
    menu +
    (o.isOwner ? '<div class="ash-toast" data-ash-toast></div>' : '') +
    '</div>' +
    script;
}

// Owner-only chip/menu/toast styling, added to the bar's <style> only when the
// viewer owns the namespace. Namespaced under .agents-share-bar with !important
// so the host page's CSS can't wash it out; z-index rides the bar's own stacking.
var OWNER_BAR_CSS =
  '.agents-share-bar .ash-chip-own{cursor:pointer;transition:background .12s}' +
  '.agents-share-bar .ash-chip-own:hover{background:rgba(255,255,255,.06)}' +
  '.agents-share-bar .ash-caret{opacity:.6;margin-left:1px;flex:none}' +
  '.agents-share-bar .ash-menu{position:absolute !important;top:calc(100% + 6px);right:12px;min-width:286px;max-width:calc(100vw - 24px);background:#151517 !important;border:1px solid #2a2a30 !important;border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.5);padding:6px;z-index:2147483647;display:none;text-align:left}' +
  '.agents-share-bar .ash-menu.ash-open{display:block}' +
  '.agents-share-bar .ash-menu h4{margin:6px 8px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#7c8290 !important;font-weight:700}' +
  '.agents-share-bar .ash-opt{display:flex;width:100%;text-align:left;align-items:flex-start;gap:10px;padding:8px;border:0;background:none;border-radius:8px;cursor:pointer;color:#e8e8e8 !important;font:inherit;font-size:13px}' +
  '.agents-share-bar .ash-opt:hover{background:rgba(255,255,255,.05)}' +
  '.agents-share-bar .ash-opt-ic{flex:none;width:26px;height:26px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06)}' +
  '.agents-share-bar .ash-opt-t{flex:1;min-width:0}' +
  '.agents-share-bar .ash-opt-t b{display:block;font-size:13px;font-weight:600;color:#f0f1f3 !important}' +
  '.agents-share-bar .ash-opt-t span{display:block;font-size:11.5px;color:#9096a0 !important;line-height:1.35;margin-top:1px;white-space:normal}' +
  '.agents-share-bar .ash-rd{flex:none;width:16px;height:16px;border-radius:50%;border:2px solid #4a4f59;margin-top:3px}' +
  '.agents-share-bar .ash-opt.ash-sel .ash-rd{border-color:#5b9dff;background:radial-gradient(circle at center,#5b9dff 0 5px,transparent 6px)}' +
  '.agents-share-bar .ash-toast{position:absolute !important;top:calc(100% + 6px);right:12px;max-width:calc(100vw - 24px);background:#151517 !important;border:1px solid #2a2a30 !important;color:#e8e8e8 !important;font-size:12px;padding:7px 12px;border-radius:9px;display:none;align-items:center;gap:7px;z-index:2147483647}' +
  '.agents-share-bar .ash-toast.ash-show{display:inline-flex}' +
  '.agents-share-bar .ash-spin{width:12px;height:12px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:ash-sp .6s linear infinite;display:inline-block;flex:none}' +
  '@keyframes ash-sp{to{transform:rotate(360deg)}}' +
  '.agents-share-bar .ash-ok{color:#30a46c;font-weight:700}' +
  '.agents-share-bar .ash-err{color:#ff6b6b;font-weight:700}';

function injectAttributionBar(html, meta, handle, opts) {
  var bar = renderAttributionBar(meta, handle, opts);
  var m = /<body[^>]*>/i.exec(html);
  if (m) {
    var at = m.index + m[0].length;
    return html.slice(0, at) + bar + html.slice(at);
  }
  return bar + html;
}

function acceptsHtml(request) {
  return (request.headers.get('accept') || '').indexOf('text/html') !== -1;
}

// Assets we can embed in a viewer page. Everything else (JSON, .txt, arbitrary
// downloads) is served raw — there is nothing useful to wrap it in.
function viewableAssetKind(contentType) {
  var ct = (contentType || '').toLowerCase();
  if (ct.indexOf('image/') === 0) return 'image';
  if (ct.indexOf('video/') === 0) return 'video';
  if (ct.indexOf('audio/') === 0) return 'audio';
  if (ct.indexOf('application/pdf') === 0) return 'pdf';
  return '';
}

// A minimal dark viewer page: the attribution bar on top, the asset centered
// below. The media element points back at THIS url with ?raw so it loads the
// stored bytes (not the viewer recursively) — and that ?raw fetch re-runs the
// same me/org gate, so a private asset stays private inside its own viewer.
function renderAssetViewer(pathname, kind, meta, handle, opts) {
  var rawUrl = escapeHtml(pathname + '?raw=1');
  var name = '';
  try { name = decodeURIComponent(pathname.split('/').pop() || 'file'); } catch (e) { name = pathname.split('/').pop() || 'file'; }
  var bar = renderAttributionBar(meta, handle, opts);
  var media = '';
  if (kind === 'image') media = '<img src="' + rawUrl + '" alt="' + escapeHtml(name) + '">';
  else if (kind === 'video') media = '<video src="' + rawUrl + '" controls playsinline></video>';
  else if (kind === 'audio') media = '<audio src="' + rawUrl + '" controls></audio>';
  else if (kind === 'pdf') media = '<iframe src="' + rawUrl + '" title="' + escapeHtml(name) + '"></iframe>';
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(name) + '</title>' +
    '<style>html,body{margin:0;background:#0f0f11}' +
    'body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
    '.ashv{max-width:100%;max-height:calc(100vh - 90px);display:flex;align-items:center;justify-content:center}' +
    '.ashv img,.ashv video{max-width:100%;max-height:calc(100vh - 90px);display:block;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5)}' +
    '.ashv audio{width:min(90vw,560px)}' +
    '.ashv iframe{width:min(94vw,1000px);height:calc(100vh - 90px);border:0;border-radius:8px;background:#fff}' +
    '</style></head><body>' + bar + '<div class="ashv">' + media + '</div></body></html>';
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Length-independent constant-time-ish compare (Workers has no timingSafeEqual).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const la = a.length, lb = b.length;
  let out = la ^ lb;
  for (let i = 0; i < la; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i % lb || 0);
  return out === 0 && la === lb;
}

// URL-safety, not collision-resistance. Two values that differ only in
// case/punctuation share a prefix.
function sanitizeNamespace(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Public handle: email local-part, plus-tag stripped. Must match CLI handleFromEmail.
function handleFromEmail(email) {
  if (!email) return '';
  const local = String(email).split('@')[0] || '';
  const beforePlus = local.split('+')[0] || local;
  return sanitizeNamespace(beforePlus);
}

function phoenixHandle(auth) {
  return handleFromEmail(auth.email) || sanitizeNamespace(auth.owner);
}

// First writer of a handle owns it. Later PUTs from the same userId are fine;
// a different userId whose email local-part collides gets 409, not a silent
// overwrite — EXCEPT when the verified Phoenix email matches the claim's
// recorded email exactly: that is the same human re-authenticated under a new
// userId (an account move), and the claim transfers to them instead of
// dead-ending (PHNX-3547). The transfer also re-stamps owner on the old
// account's objects so PATCH/DELETE keep working.
async function assertHandleOwner(bucket, handle, userId, email) {
  // The __handles/<handle> claim object is the authoritative first-writer record
  // of ownership. When it exists it decides ownership OUTRIGHT: the recorded
  // userId may write, anyone else is refused. Consult it FIRST — a stray page
  // under the namespace stamped with a different owner (e.g. a BYO WRITE_TOKEN
  // publish, which stamps owner = SHARE_NAMESPACE rather than a userId, or a page
  // published under the same human's earlier userId before a re-auth) must not
  // lock the rightful claim holder out of their own handle (PHNX-3291).
  const key = '__handles/' + handle;
  const existing = await bucket.get(key);
  if (existing) {
    const meta = existing.customMetadata || {};
    const claimed = meta.userId;
    if (claimed && claimed !== userId) {
      // Same verified email, different userId → account move, not a rival:
      // rebind the claim and migrate the old owner's objects. Legacy claims
      // written before the claim recorded an email cannot prove this and keep
      // the permanent 409.
      if (email && meta.email && String(meta.email).toLowerCase() === String(email).toLowerCase()) {
        await transferHandle(bucket, handle, claimed, userId, email);
        return {};
      }
      return { error: json({ error: 'handle taken', handle: handle }, 409) };
    }
    return {};
  }
  // No claim object yet — fall back to the page-owner scan so a colliding email
  // local-part cannot PUT/DELETE another account's objects in the window before
  // the claim exists. (claimHandle writes the claim on the first Phoenix PUT.)
  // Only a DIFFERENT Phoenix userId blocks: a BYO WRITE_TOKEN publish stamps
  // owner = the namespace (=== handle) rather than a userId, so it is not a rival
  // identity and must not lock the handle's first Phoenix claimant out (PHNX-3291).
  const list = await bucket.list({ prefix: handle + '/', include: ['customMetadata'] });
  for (const o of list.objects || []) {
    const owner = o.customMetadata && o.customMetadata.owner;
    if (owner && owner !== userId && owner !== handle) {
      return { error: json({ error: 'handle taken', handle: handle }, 409) };
    }
  }
  return {};
}

// Account-move recovery (PHNX-3547): the claim's recorded userId held the handle;
// the caller proves the SAME verified email under a NEW userId. Rebind the claim
// and re-stamp owner on every object the old userId owned under this prefix, so
// the moved account keeps full control of its shares. Objects owned by anyone
// else (BYO namespace stamps, a pre-claim stray) are left untouched.
async function transferHandle(bucket, handle, oldUserId, newUserId, email) {
  await bucket.put('__handles/' + handle, JSON.stringify({ userId: newUserId, email: email }), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: newUserId, email: email, visibility: 'unlisted' },
  });
  let cursor;
  do {
    const list = await bucket.list({ prefix: handle + '/', cursor: cursor, include: ['customMetadata'] });
    for (const o of list.objects || []) {
      const owner = o.customMetadata && o.customMetadata.owner;
      if (!owner || owner !== oldUserId) continue;
      const obj = await bucket.get(o.key);
      if (!obj) continue;
      const headers = new Headers();
      if (typeof obj.writeHttpMetadata === 'function') obj.writeHttpMetadata(headers);
      const customMetadata = { ...(obj.customMetadata || {}), owner: newUserId };
      await bucket.put(o.key, obj.body, {
        httpMetadata: headers.get('content-type') ? { contentType: headers.get('content-type') } : undefined,
        customMetadata: customMetadata,
      });
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

async function claimHandle(bucket, handle, userId, email) {
  const owned = await assertHandleOwner(bucket, handle, userId, email);
  if (owned.error) return owned;
  const key = '__handles/' + handle;
  // Write (or rewrite) so a same-user republish resets object Age against the
  // bucket's 366-day lifecycle — otherwise the claim can expire while pages stay
  // live. The claim also records the verified email: it is what lets a future
  // same-email/different-userId request prove an account move and recover the
  // handle instead of hitting the permanent 409.
  await bucket.put(key, JSON.stringify({ userId: userId, email: email }), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { userId: userId, email: email || '', visibility: 'unlisted' },
  });
  return {};
}

function normalizeVisibility(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (!v || v === 'public') return { value: 'public' };
  if (v === 'unlisted' || v === 'private' || v === 'me' || v === 'org') return { value: v };
  return { error: json({ error: 'visibility must be public, unlisted, private, me, or org' }, 400) };
}

function emailDomain(email) {
  if (!email) return '';
  const at = String(email).lastIndexOf('@');
  if (at < 0) return '';
  return String(email).slice(at + 1).toLowerCase();
}

function isHiddenFromGallery(visibility) {
  return visibility === 'unlisted' || visibility === 'private' || visibility === 'me' || visibility === 'org';
}

function isIdentityGated(visibility) {
  return visibility === 'me' || visibility === 'org';
}

function managedCoverHeaders(visibility) {
  const headers = new Headers({ 'content-type': 'image/png' });
  // Token-gated (private) + identity-gated (me/org) covers must never be
  // cached by a shared proxy, and never indexed. RFC 9111: public on an
  // Authorization response authorizes reuse for later unauthenticated
  // requests keyed on /user/slug.png (PHNX-3676).
  if (isIdentityGated(visibility) || visibility === 'private') {
    headers.set('cache-control', 'private, no-store');
    headers.set('X-Robots-Tag', 'noindex');
  } else {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    if (visibility === 'unlisted') headers.set('X-Robots-Tag', 'noindex');
  }
  return headers;
}

// Gate a me/org read given the ALREADY-RESOLVED viewer identity. Pure/sync: the
// caller resolves the viewer once (it also needs the identity for the ownership
// check) and both the page GET and the ?revisions=json path share this gate.
async function gateVisibility(url, env, obj, identity) {
  const visibility = (obj.customMetadata && obj.customMetadata.visibility) || 'public';
  if (!isIdentityGated(visibility)) return null;
  if (!identity) return bounceToLogin(url, env);
  if (!viewerMayRead(visibility, obj.customMetadata, identity)) {
    // A 'me' page reads for its stamped owner (the fast path above) OR for the
    // holder of the namespace's handle claim — the same authority PATCH and
    // DELETE use. Without this, the claim holder who takes a fleet/BYO-stamped
    // or pre-stamp page to 'me' (owner = namespace, or none) would be locked
    // out of her own page: PATCH says 200, GET says 404. The stamp itself stays
    // untouched (expiry refunds credit the stamped ledger), so the read gate
    // has to consult the claim rather than the stamp.
    const handle = decodeURIComponent(url.pathname).split('/').filter(Boolean)[0] || '';
    if (visibility === 'me' && handle && (await holdsHandleClaim(env.BUCKET, handle, identity.userId))) return null;
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  return null;
}

// True when userId is the recorded holder of the __handles/<handle> claim.
// Read-only: never transfers or writes a claim (that is claimHandle /
// assertHandleOwner's job on the write paths).
async function holdsHandleClaim(bucket, handle, userId) {
  if (!handle || !userId) return false;
  const claim = await bucket.get('__handles/' + handle);
  if (!claim) return false;
  const claimed = claim.customMetadata && claim.customMetadata.userId;
  return !!claimed && claimed === userId;
}

// SHA-256 hex of a string — the form a 'private' object's stored
// 'viewer-token-hash' takes. Both the PUT (hash-on-store) and the read gate use
// this, so a token minted by the CLI matches byte-for-byte (PHNX-3654).
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return bufToHex(digest);
}

// The viewer key a reader presents for a token-gated ('private') page: the ?k=
// query param first (the shape the CLI emits — https://host/<u>/<s>?k=<token>),
// then an Authorization: Bearer token as an alternative for scripted callers.
function readViewerKey(request, url) {
  const q = url.searchParams.get('k');
  if (q) return q;
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\\s+/i, '');
  return bearer || '';
}

// Gate a 'private' (token-gated) read (PHNX-3654). Returns a 404 Response when
// the request may NOT read, or null when it may. A miss ALWAYS 404s — never a
// 401 and never a distinct "wrong key" — so a token-gated page never even leaks
// that it exists, exactly like a wrong me/org viewer. The namespace owner
// (resolved identity whose userId stamped the object) is let through without the
// key so 'share open' and the owner's own browsing still work. Constant-time
// compare (safeEqual) over the stored SHA-256 hash keeps the check timing-safe.
async function gateTokenRead(request, url, obj, identity) {
  const meta = obj.customMetadata || {};
  const visibility = meta.visibility || 'public';
  if (visibility !== 'private') return null;
  const notFound = function () {
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
  // Owner bypass: the signed-in owner of the page reads their own private page
  // without the key (mirrors 'me').
  if (identity && meta.owner && meta.owner === identity.userId) return null;
  const stored = meta['viewer-token-hash'] || '';
  // Fail closed: a private object with no stored hash can never be matched, so it
  // is unreadable rather than accidentally public.
  if (!stored) return notFound();
  const presented = readViewerKey(request, url);
  if (!presented) return notFound();
  const presentedHash = await sha256Hex(presented);
  if (!safeEqual(presentedHash, stored)) return notFound();
  return null;
}

// Per-slug view counter, stored as a SEPARATE R2 object under __views/<path> so
// counting a view never rewrites the page object (which would reset its uploaded
// timestamp and corrupt "last updated"). Best-effort telemetry: a read/write
// failure must never break page serving, so both degrade to a no-op rather than
// throwing. R2 has no atomic increment, so two simultaneous views can race and
// lose a count — acceptable for an approximate visitor count.
async function readViews(env, path) {
  try {
    const obj = await env.BUCKET.get('__views/' + path);
    if (!obj) return 0;
    const raw = typeof obj.text === 'function' ? await obj.text() : '';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeViews(env, path, count) {
  try {
    await env.BUCKET.put('__views/' + path, String(count), {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
  } catch {
    // best-effort: a failed counter write must never surface to the visitor
  }
}

// --- PHNX-3542 per-user usage ledger (R2 conditional-put CAS) ---------------
// The ledger is a single R2 object at __usage/<owner> holding the running
// { bytes, count, plan, rlStart, rlUsed } for one user. It mirrors the __views /
// __handles precedent: a __-prefixed key, GET-blocked and outside every gallery/
// listing/revision prefix. R2 has no atomic increment, so mutations use a
// read → mutate → conditional-put loop (onlyIf.etagMatches), the same primitive
// the PATCH metadata-edit path already relies on.
function usageKey(owner) { return '__usage/' + sanitizeNamespace(owner); }

async function readUsage(env, owner) {
  const obj = await env.BUCKET.get(usageKey(owner));
  if (!obj) return { etag: null, usage: freshUsage() };
  let usage = freshUsage();
  try {
    const raw = typeof obj.text === 'function' ? await obj.text() : '';
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      usage = {
        bytes: usageNumber(parsed.bytes, 0),
        count: usageNumber(parsed.count, 0),
        plan: typeof parsed.plan === 'string' ? parsed.plan : DEFAULT_SHARE_PLAN,
        rlStart: usageNumber(parsed.rlStart, 0),
        rlUsed: usageNumber(parsed.rlUsed, 0),
      };
    }
  } catch (e) {
    // Malformed ledger — treat as fresh zero but KEEP the etag so the next CAS
    // put overwrites the corrupt object rather than looping against it forever.
  }
  return { etag: obj.etag || null, usage: usage };
}

async function writeUsageCas(env, owner, prevEtag, usage) {
  const body = JSON.stringify(usage);
  const opts = { httpMetadata: { contentType: 'application/json' } };
  if (prevEtag) {
    // Existing object: conditional put. R2 returns null when the etag no longer
    // matches (a concurrent writer won the race) → report failure so the caller
    // re-reads and retries.
    opts.onlyIf = { etagMatches: prevEtag };
    const res = await env.BUCKET.put(usageKey(owner), body, opts);
    return res !== null;
  }
  // Fresh key: plain create. Neither R2 nor the test harness exposes a
  // conditional-create predicate, so the only race is two simultaneous
  // first-creates of the same owner's ledger — a benign, one-time bounded loss.
  await env.BUCKET.put(usageKey(owner), body, opts);
  return true;
}

// CAS retry loop. fn(usage) returns { reject: Response } to fail loud without
// committing, or { commit: usage, result } to persist and return result. On CAS
// contention it re-reads and retries; exhausting the retries fails loud with 503.
async function withUsage(env, owner, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const state = await readUsage(env, owner);
    const outcome = fn(state.usage);
    if (outcome.reject) return outcome.reject;
    const ok = await writeUsageCas(env, owner, state.etag, outcome.commit);
    if (ok) return outcome.result;
  }
  return json({ error: 'usage ledger contended, retry' }, 503);
}

function rateLimited(retryAfterSec, ratePerHour) {
  return new Response(
    JSON.stringify({ error: 'rate limit: too many publishes, retry later', retryAfterSec: retryAfterSec, ratePerHour: ratePerHour }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) } },
  );
}

// Charge one authed PUT against the owner's ledger. Rate → per-file cap → object
// count → byte quota, each failing loud (429 / 413) before anything is written.
// Returns { error: Response } on any rejection, else { limits } (the resolved
// plan limits, reused by the post-write real-size reconcile). Managed only: the
// caller guards on auth.kind === 'phoenix'.
async function chargeShareWrite(env, auth, params) {
  const now = Date.now();
  const out = await withUsage(env, auth.owner, function (usage) {
    const limits = planLimits(usage.plan);
    // Rate limit — only a user-initiated page PUT counts (countRate). A fixed 1h
    // window: reset when the window has rolled over, otherwise reject at the cap.
    if (params.countRate) {
      if (now - usage.rlStart >= RATE_WINDOW_MS) { usage.rlStart = now; usage.rlUsed = 0; }
      if (usage.rlUsed >= limits.ratePerHour) {
        const retryAfterSec = Math.max(1, Math.ceil((usage.rlStart + RATE_WINDOW_MS - now) / 1000));
        return { reject: rateLimited(retryAfterSec, limits.ratePerHour) };
      }
      usage.rlUsed += 1;
    }
    // Per-file size cap.
    if (typeof params.fileBytes === 'number' && params.fileBytes > limits.maxFileBytes) {
      return { reject: json({ error: 'file too large', maxBytes: limits.maxFileBytes, gotBytes: params.fileBytes }, 413) };
    }
    // Object (canonical page) count.
    if (params.newCanonical) {
      if (usage.count + 1 > limits.maxObjects) {
        return { reject: json({ error: 'artifact limit reached', maxObjects: limits.maxObjects }, 413) };
      }
      usage.count += 1;
    }
    // Total byte quota. charge may be negative on a shrink — clamp at >= 0.
    if (usage.bytes + params.charge > limits.maxBytes) {
      return { reject: json({ error: 'storage limit reached', maxBytes: limits.maxBytes, usedBytes: usage.bytes }, 413) };
    }
    usage.bytes = Math.max(0, usage.bytes + params.charge);
    return { commit: usage, result: { limits: limits } };
  });
  if (out instanceof Response) return { error: out };
  return { limits: out.limits };
}

// Read a request body fully into memory, BOUNDED: abort the moment it exceeds
// maxBytes, so a chunked/streaming body can never buffer more than the cap (plus
// one in-flight chunk) and OOM the Worker. Returns { oversize: true, size } once
// the cap is passed (size is a lower bound, >= cap), else { bytes, size } with
// the exact bytes. A body-less request yields an empty buffer. This is what lets
// enforcement key on the REAL size instead of a spoofable declared header.
async function readBodyBounded(request, maxBytes) {
  if (!request.body || typeof request.body.getReader !== 'function') {
    const buf = await request.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength > maxBytes) return { oversize: true, size: bytes.byteLength };
    return { bytes: bytes, size: bytes.byteLength };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    size += chunk.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch (e) { /* best-effort */ }
      return { oversize: true, size: size };
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], offset); offset += chunks[i].byteLength; }
  return { bytes: out, size: size };
}

// Refund on DELETE / expiry. Never rejects, never creates a ledger: if the owner
// was never charged (no __usage object) it is a pure no-op.
async function refundShareWrite(env, owner, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const state = await readUsage(env, owner);
    if (!state.etag) return; // no ledger — owner never charged, nothing to refund
    state.usage.bytes = Math.max(0, state.usage.bytes - (params.refund || 0));
    if (params.freeCanonical) state.usage.count = Math.max(0, state.usage.count - 1);
    if (await writeUsageCas(env, owner, state.etag, state.usage)) return;
  }
}

function viewerMayRead(visibility, meta, identity) {
  if (visibility === 'me') {
    const owner = meta && meta.owner;
    return !!owner && owner === identity.userId;
  }
  if (visibility === 'org') {
    const stamped = meta && meta.org_domain;
    if (!stamped) return false;
    return emailDomain(identity.email) === String(stamped).toLowerCase();
  }
  return true;
}

function bounceToLogin(url, env) {
  const base = typeof env.PHOENIX_ID_BASE === 'string' ? env.PHOENIX_ID_BASE.replace(/\\/+$/, '') : '';
  if (!base) return json({ error: 'phoenix login is not configured' }, 401);
  return new Response(null, {
    status: 302,
    headers: { Location: base + '/login?return=' + encodeURIComponent(url.toString()) },
  });
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() === name) return p.slice(eq + 1).trim();
  }
  return '';
}

function toB64Url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bufToHex(sig);
}

async function signShareCookie(identity, env) {
  const secret = typeof env.WRITE_TOKEN === 'string' ? env.WRITE_TOKEN : '';
  if (!secret) return '';
  const exp = Math.floor(Date.now() / 1000) + SHARE_COOKIE_MAX_AGE;
  const payload = identity.userId + '|' + (identity.email || '') + '|' + exp;
  const sig = await hmacHex(secret, payload);
  const value = toB64Url(payload) + '.' + sig;
  return SHARE_COOKIE + '=' + value + '; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=' + SHARE_COOKIE_MAX_AGE;
}

// A short-lived login ticket, self-signed with the same HMAC secret as the cookie
// but DOMAIN-SEPARATED (the signature covers a 'ticket:'-prefixed payload), so a
// ticket value can never be replayed as a cookie value or vice versa. It rides in
// the ?phoenix_ticket= param for exactly one navigation; resolveViewer verifies it
// locally and exchanges it for the __share cookie. TTL is deliberately tiny — it
// only has to survive the round-trip from CLI mint to the browser opening the URL.
var SELF_TICKET_MAX_AGE = 120;

async function signSelfTicket(identity, env) {
  const secret = typeof env.WRITE_TOKEN === 'string' ? env.WRITE_TOKEN : '';
  if (!secret || !identity || !identity.userId) return '';
  const exp = Math.floor(Date.now() / 1000) + SELF_TICKET_MAX_AGE;
  const payload = identity.userId + '|' + (identity.email || '') + '|' + exp;
  const sig = await hmacHex(secret, 'ticket:' + payload);
  return toB64Url(payload) + '.' + sig;
}

async function verifySelfTicket(ticket, env) {
  const secret = typeof env.WRITE_TOKEN === 'string' ? env.WRITE_TOKEN : '';
  if (!secret || !ticket) return null;
  const dot = ticket.lastIndexOf('.');
  if (dot < 1) return null;
  let payload;
  try {
    payload = fromB64Url(ticket.slice(0, dot));
  } catch {
    return null;
  }
  const sig = ticket.slice(dot + 1);
  const expected = await hmacHex(secret, 'ticket:' + payload);
  if (!safeEqual(sig, expected)) return null;
  const first = payload.indexOf('|');
  const last = payload.lastIndexOf('|');
  if (first < 0 || last <= first) return null;
  const userId = payload.slice(0, first);
  const email = payload.slice(first + 1, last);
  const exp = Number(payload.slice(last + 1));
  if (!userId || !Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return null;
  return { userId: userId, email: email };
}

// Single-use enforcement for a self-signed ticket: claim its signature the first
// time it is redeemed, and reject any later presentation of the same ticket. The
// HMAC + short TTL stop forgery and bound the window, but without this a ticket the
// CLI printed (--json / --no-open / a browser-open failure) could be replayed by
// anyone who captured that output before it expired, minting the owner's 7-day
// cookie a second time. Get-then-put mirrors claimHandle's one-time-claim pattern;
// the marker rides a __-prefixed key (GET-blocked, excluded from every listing).
async function consumeSelfTicket(env, sig) {
  if (!sig) return false;
  const key = '__ticket-used/' + sig;
  const existing = await env.BUCKET.get(key);
  if (existing) return false;
  await env.BUCKET.put(key, '1', {
    httpMetadata: { contentType: 'text/plain' },
    customMetadata: { visibility: 'unlisted' },
  });
  return true;
}

async function identityFromCookie(request, env) {
  const secret = typeof env.WRITE_TOKEN === 'string' ? env.WRITE_TOKEN : '';
  if (!secret) return null;
  const raw = readCookie(request, SHARE_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  let payload;
  try {
    payload = fromB64Url(raw.slice(0, dot));
  } catch {
    return null;
  }
  const sig = raw.slice(dot + 1);
  const expected = await hmacHex(secret, payload);
  if (!safeEqual(sig, expected)) return null;
  const first = payload.indexOf('|');
  const last = payload.lastIndexOf('|');
  if (first < 0 || last <= first) return null;
  const userId = payload.slice(0, first);
  const email = payload.slice(first + 1, last);
  const cookieExp = Number(payload.slice(last + 1));
  if (!userId || !Number.isFinite(cookieExp) || Math.floor(Date.now() / 1000) > cookieExp) return null;
  return { userId: userId, email: email };
}

async function redeemTicket(ticket, env) {
  const base = typeof env.PHOENIX_ID_BASE === 'string' ? env.PHOENIX_ID_BASE.replace(/\\/+$/, '') : '';
  if (!base || !ticket) return null;
  let res;
  try {
    res = await fetch(base + '/api/v1/auth/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: ticket }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body.userId !== 'string' || !body.userId) return null;
  return { userId: body.userId, email: typeof body.email === 'string' ? body.email : '' };
}

async function resolveViewer(request, env, url) {
  const claims = await hooks.verifyPhoenixToken(request, env);
  if (claims && typeof claims.userId === 'string' && claims.userId) {
    return { identity: { userId: claims.userId, email: typeof claims.email === 'string' ? claims.email : '' } };
  }
  const cookieId = await identityFromCookie(request, env);
  if (cookieId) return { identity: cookieId };
  const ticket = url.searchParams.get('phoenix_ticket');
  if (!ticket) return {};
  // Prefer the locally-verifiable self-signed ticket (PHNX-3370, no network), and
  // enforce single use by claiming its signature on first redemption — a captured
  // ticket replayed within its TTL finds it already spent. Fall back to the
  // external identity-server redeem for tickets it issued.
  let redeemed = await verifySelfTicket(ticket, env);
  if (redeemed) {
    const sig = ticket.slice(ticket.lastIndexOf('.') + 1);
    if (!(await consumeSelfTicket(env, sig))) redeemed = null;
  } else {
    redeemed = await redeemTicket(ticket, env);
  }
  if (!redeemed) return { error: json({ error: 'invalid ticket' }, 401) };
  const cookie = await signShareCookie(redeemed, env);
  if (!cookie) return { error: json({ error: 'phoenix login is not configured' }, 401) };
  url.searchParams.delete('phoenix_ticket');
  const headers = new Headers();
  headers.set('Location', url.toString());
  headers.append('Set-Cookie', cookie);
  return { redirect: new Response(null, { status: 302, headers: headers }) };
}

function extractHtmlMeta(html, field) {
  const pattern = field === 'title'
    ? /<title[^>]*>([\\s\\S]*?)<\\/title>/i
    : /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["'][^>]*>/i;
  const match = pattern.exec(html);
  return match ? match[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() : '';
}

let rendererReady;
async function renderOgCard(input) {
  if (!rendererReady) {
    rendererReady = Promise.all([
      initYoga(yogaWasm).then(function (yoga) { initSatori(yoga); }),
      initResvg(resvgWasm),
    ]);
  }
  await rendererReady;
  const visibilityLabels = {
    public: 'PUBLIC',
    unlisted: 'UNLISTED',
    private: 'PROTECTED',
    me: 'ONLY YOU',
    org: input.orgDomain ? 'ANYONE AT ' + input.orgDomain.toUpperCase() : 'ORGANIZATION',
  };
  const node = {
    type: 'div',
    props: {
      style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0a0a0a', color: '#f5f5f5', padding: '68px 76px 58px', fontFamily: 'Inter' },
      children: [
        { type: 'div', props: { style: { display: 'flex', color: '#a3e635', fontFamily: 'JetBrains Mono', fontSize: 25, fontWeight: 600, letterSpacing: '-0.5px' }, children: 'share.getrush.ai' } },
        { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center', maxWidth: 1050 }, children: [
          { type: 'div', props: { style: { display: 'flex', fontSize: 66, lineHeight: 1.06, fontWeight: 700, letterSpacing: '-2.8px', maxHeight: 218, overflow: 'hidden' }, children: input.title || 'Shared artifact' } },
          input.description ? { type: 'div', props: { style: { display: 'flex', marginTop: 24, color: '#a3a3a3', fontSize: 27, lineHeight: 1.35, maxHeight: 74, overflow: 'hidden' }, children: input.description } } : null,
        ].filter(Boolean) } },
        { type: 'div', props: { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #262626', paddingTop: 25, fontSize: 21, color: '#a3a3a3' }, children: [
          { type: 'div', props: { style: { display: 'flex' }, children: [
            { type: 'span', props: { style: { color: '#737373' }, children: 'shared by ' } },
            { type: 'span', props: { style: { marginLeft: 7, color: '#f5f5f5', fontWeight: 700 }, children: '@' + input.handle } },
          ] } },
          { type: 'div', props: { style: { display: 'flex', border: '1px solid #3f3f46', borderRadius: 999, padding: '9px 17px', color: '#d4d4d8', fontFamily: 'JetBrains Mono', fontSize: 16, letterSpacing: '1px' }, children: visibilityLabels[input.visibility] || 'PUBLIC' } },
        ] } },
      ],
    },
  };
  const svg = await satori(node, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
      { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
      { name: 'JetBrains Mono', data: jetbrainsMono, weight: 600, style: 'normal' },
    ],
  });
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}

async function defaultVerifyPhoenixToken(request, env) {
  const presented = (request.headers.get('authorization') || '').replace(/^Bearer\\s+/i, '');
  if (!presented) return null;
  const base = typeof env.PHOENIX_ID_BASE === 'string' ? env.PHOENIX_ID_BASE.replace(/\\/+$/, '') : '';
  if (!base) return null;
  let res;
  try {
    res = await fetch(base + '/api/v1/auth/me', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + presented },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body.userId !== 'string' || !body.userId) return null;
  return { userId: body.userId, email: typeof body.email === 'string' ? body.email : '' };
}

// Write principals, in order: WRITE_TOKEN equality (admin/BYO), then a Phoenix
// bearer, then the signed-in viewer's __share cookie. The cookie is an
// HMAC-signed {userId,email} proof (identityFromCookie verifies it), which lets
// the shared page's inline visibility control PATCH with credentials:'include'
// and no bearer — the browser has the identity cookie, not a token. It cannot be
// abused cross-site: the cookie is SameSite=Lax, which blocks it from riding a
// cross-origin non-GET (CSRF), and namespace/owner enforcement on PUT/PATCH/
// DELETE still confines a cookie holder to their own pages. 401 when none apply.
async function authorizeWrite(request, env) {
  const presented = (request.headers.get('authorization') || '').replace(/^Bearer\\s+/i, '');
  if (presented) {
    if (env.WRITE_TOKEN && safeEqual(presented, env.WRITE_TOKEN)) {
      return { kind: 'byo', owner: env.SHARE_NAMESPACE || 'byo' };
    }
    const claims = await hooks.verifyPhoenixToken(request, env);
    if (claims && typeof claims.userId === 'string' && claims.userId) {
      return { kind: 'phoenix', owner: claims.userId, email: typeof claims.email === 'string' ? claims.email : '' };
    }
  }
  const cookieId = await identityFromCookie(request, env);
  if (cookieId && cookieId.userId) {
    return { kind: 'phoenix', owner: cookieId.userId, email: typeof cookieId.email === 'string' ? cookieId.email : '' };
  }
  return { error: json({ error: 'unauthorized' }, 401) };
}

// ---- Same-origin human collaboration transport (PHNX-3835) ----
//
// The Worker is the trust boundary for collaboration exactly as it is for the
// page GET. For every /__collab/* request it:
//   1. loads the R2 share object FIRST (object-first) and 404s if absent — share
//      existence is never enumerable, and a deleted share drops its comments the
//      instant the object is gone (no separate revocation step);
//   2. re-derives share identity, current revision (etag), owner, visibility,
//      org domain, and producer provenance SERVER-SIDE from R2 metadata, ignoring
//      anything the browser supplied (the 'share' field is a LOOKUP key only,
//      never trusted as identity);
//   3. reuses the EXACT page read gate (me/org identity gate + private token
//      gate), mapping any denial to 404 so an out-of-scope viewer cannot tell the
//      share exists; every WRITE additionally requires a verified signed-in
//      Phoenix human;
//   4. proxies to the Prix artifact-collaboration API with the service token in
//      Authorization (never surfaced to the browser) plus trusted X-Artifact-* /
//      X-Phoenix-* headers, streaming SSE through without buffering.
//
// Missing PRIX_ARTIFACT_COLLAB_BASE or ARTIFACT_COLLAB_SERVICE_TOKEN disables the
// whole surface (404) without touching artifact page GET.

var COLLAB_VISIBILITIES = ['public', 'unlisted', 'private', 'me', 'org'];

// The managed collaboration backend, or null when unconfigured. Both the base
// URL and the service token must be present; either missing fails the whole
// surface closed.
function collabConfig(env) {
  const base = typeof env.PRIX_ARTIFACT_COLLAB_BASE === 'string' ? env.PRIX_ARTIFACT_COLLAB_BASE.replace(/\\/+$/, '').trim() : '';
  const token = typeof env.ARTIFACT_COLLAB_SERVICE_TOKEN === 'string' ? env.ARTIFACT_COLLAB_SERVICE_TOKEN : '';
  if (!base || !token) return null;
  return { base: base, token: token };
}

// No collaboration response may be cached (visibility can downgrade on any
// request), and every collab body is JSON unless overridden (SSE).
function collabHeaders(extra) {
  const h = new Headers(extra || {});
  if (!h.has('content-type')) h.set('content-type', 'application/json');
  h.set('cache-control', 'no-store');
  return h;
}

function collabError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status: status, headers: collabHeaders() });
}

// A collab denial is ALWAYS a 404 — never a 302 login bounce or a 401 for a read
// — so an out-of-scope viewer cannot enumerate share existence.
function collabNotFound() {
  return collabError('not found', 404);
}

// The page READ gate, reused verbatim for collaboration reads/subscriptions but
// with every denial normalized to 404. Returns null when the read is allowed.
async function collabReadGate(request, url, obj, identity) {
  const visibility = (obj.customMetadata && obj.customMetadata.visibility) || 'public';
  // Unknown visibility fails closed.
  if (COLLAB_VISIBILITIES.indexOf(visibility) === -1) return collabNotFound();
  if (isIdentityGated(visibility)) {
    // me/org: require a matching identity; a missing/wrong viewer 404s (never the
    // page GET's 302 login bounce, which is meaningless to a fetch()).
    if (!identity || !viewerMayRead(visibility, obj.customMetadata, identity)) return collabNotFound();
    return null;
  }
  if (visibility === 'private') {
    // private: require the viewer token, exactly as the page GET does.
    const denied = await gateTokenRead(request, url, obj, identity);
    if (denied) return collabNotFound();
    return null;
  }
  return null; // public | unlisted — readable when the object exists
}

// Map a browser /__collab sub-route to the Prix artifact-collaboration route +
// method. Returns null for any unsupported shape (fail loud, never a wrong path).
// Only the cursor rides through as a query param; the browser's own \`share\`
// param is dropped (Prix derives identity from the trusted header, not the path).
function collabTarget(rest, method, url) {
  if (rest.length === 1 && rest[0] === 'context' && method === 'GET') {
    return { path: '/context', search: '', sse: false };
  }
  if (rest.length === 1 && rest[0] === 'threads') {
    if (method === 'GET') {
      const after = url.searchParams.get('after');
      return { path: '/threads', search: after ? '?after=' + encodeURIComponent(after) : '', sse: false };
    }
    if (method === 'POST') return { path: '/threads', search: '', sse: false };
  }
  if (rest.length === 2 && rest[0] === 'threads' && method === 'PATCH') {
    return { path: '/threads/' + encodeURIComponent(rest[1]), search: '', sse: false };
  }
  if (rest.length === 3 && rest[0] === 'threads' && rest[2] === 'replies' && method === 'POST') {
    return { path: '/threads/' + encodeURIComponent(rest[1]) + '/replies', search: '', sse: false };
  }
  if (rest.length === 2 && rest[0] === 'comments' && method === 'PATCH') {
    return { path: '/comments/' + encodeURIComponent(rest[1]), search: '', sse: false };
  }
  if (rest.length === 1 && rest[0] === 'events' && method === 'GET') {
    return { path: '/events', search: '', sse: true };
  }
  return null;
}

async function handleCollab(request, env, url, path, ctx) {
  const cfg = collabConfig(env);
  // Fail closed: no managed backend → the surface does not exist.
  if (!cfg) return collabNotFound();

  const segs = path.split('/').filter(Boolean); // ['__collab', ...]
  const rest = segs.slice(1);
  const method = request.method;

  // Resolve the share path. GET carries it in ?share=, mutations in the JSON
  // body — read that body ONCE here so \`share\` extraction and verbatim upstream
  // forwarding share a single read.
  const isMutation = method === 'POST' || method === 'PATCH';
  let sharePath = '';
  let bodyText = '';
  if (isMutation) {
    bodyText = await request.text();
    let parsed;
    try { parsed = JSON.parse(bodyText || '{}'); } catch { return collabError('body must be JSON', 400); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return collabError('body must be a JSON object', 400);
    sharePath = typeof parsed.share === 'string' ? parsed.share : '';
  } else {
    sharePath = url.searchParams.get('share') || '';
  }
  sharePath = String(sharePath).replace(/^\\/+/, '');
  const shareFirst = sharePath.split('/').filter(Boolean)[0] || '';
  // Never let a collab lookup reach an internal __-key or an empty share.
  if (!sharePath || shareFirst.startsWith('__')) return collabNotFound();

  // OBJECT-FIRST: load the share before deriving anything. A missing share
  // (never provisioned, or just deleted) 404s.
  const obj = await env.BUCKET.get(sharePath);
  if (!obj) return collabNotFound();

  // Re-derive identity SERVER-SIDE and apply the page read gate. Collab clients
  // authenticate with the Bearer or the __share cookie, never a ?phoenix_ticket=
  // (that is a page-navigation param the CLI appends when OPENING a page). So we
  // use only the resolved identity and ignore any redirect outcome — a 302 login
  // bounce is meaningless to a fetch(). If a ticket were present it would be
  // redeemed (and, being single-use, consumed) here but its cookie discarded, so
  // the request falls through as anonymous — the fail-safe (more restrictive)
  // direction, never an escalation.
  const viewer = await resolveViewer(request, env, url);
  const identity = viewer.identity || null;
  const readDenied = await collabReadGate(request, url, obj, identity);
  if (readDenied) return readDenied;

  // Every write requires a verified signed-in Phoenix human, ON TOP of the read
  // gate (public/unlisted readers may read anonymously but never write).
  if (isMutation && (!identity || !identity.userId)) {
    return collabError('sign in with Phoenix to comment', 401);
  }

  const target = collabTarget(rest, method, url);
  if (!target) return collabError('unsupported collaboration route', 404);

  // Trusted, server-derived values. owner + NUL + normalized path → a stable
  // share id; the raw private access token is NEVER used as identity.
  const meta = obj.customMetadata || {};
  const visibility = meta.visibility || 'public';
  const owner = meta.owner || '';
  const shareId = await sha256Hex(owner + '\\u0000' + sharePath);
  const revision = obj.etag || '';

  const headers = new Headers();
  headers.set('authorization', 'Bearer ' + cfg.token);
  headers.set('x-artifact-share-id', shareId);
  if (revision) headers.set('x-artifact-revision', revision);
  headers.set('x-artifact-visibility', visibility);
  if (owner) headers.set('x-artifact-owner-id', owner);
  if (meta.org_domain) headers.set('x-artifact-org-domain', meta.org_domain);
  if (identity && identity.userId) headers.set('x-phoenix-actor-id', identity.userId);
  if (identity && identity.email) headers.set('x-phoenix-actor-email', identity.email);
  // Preserve existing R2 producer provenance (RUSH-2683) so Prix can attribute a
  // comment thread to the run that made the artifact.
  if (meta.agent) headers.set('x-artifact-agent', meta.agent);
  if (meta.session) headers.set('x-artifact-session', meta.session);
  if (meta.host) headers.set('x-artifact-host', meta.host);
  if (meta.repo) headers.set('x-artifact-repo', meta.repo);
  // Idempotency + resumable-SSE headers ride through unchanged.
  const idem = request.headers.get('idempotency-key');
  if (idem) headers.set('idempotency-key', idem);
  const lastEvent = request.headers.get('last-event-id');
  if (lastEvent) headers.set('last-event-id', lastEvent);
  if (target.sse) headers.set('accept', 'text/event-stream');
  else if (isMutation) headers.set('content-type', 'application/json');

  const init = { method: method, headers: headers };
  if (isMutation) init.body = bodyText;
  // Propagate a client disconnect to the upstream fetch (SSE cancel).
  if (request.signal) init.signal = request.signal;

  let upstream;
  try {
    upstream = await hooks.collabFetch(new Request(cfg.base + '/v1/artifact-collaboration' + target.path + target.search, init));
  } catch (e) {
    return collabError('collaboration backend unavailable', 502);
  }

  // Forward Prix status + body. Never echo the service token; every collab
  // response is no-store. SSE streams through unbuffered — event IDs and content
  // type ride the bytes, and disabling proxy buffering keeps the stream live.
  const ct = upstream.headers.get('content-type');
  const outHeaders = collabHeaders();
  if (target.sse) {
    outHeaders.set('content-type', ct || 'text/event-stream');
    outHeaders.set('x-accel-buffering', 'no');
  } else if (ct) {
    outHeaders.set('content-type', ct);
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// Best-effort authenticated purge of a deleted share's collaboration threads.
// Swallows every error — a purge failure must never fail the share delete, and
// object-first gating already made the comments inaccessible.
async function purgeCollab(env, cfg, owner, sharePath) {
  try {
    const shareId = await sha256Hex((owner || '') + '\\u0000' + sharePath);
    const headers = new Headers();
    headers.set('authorization', 'Bearer ' + cfg.token);
    headers.set('x-artifact-share-id', shareId);
    await hooks.collabFetch(new Request(cfg.base + '/v1/artifact-collaboration/purge', { method: 'POST', headers: headers }));
  } catch (e) {
    // best-effort: a purge failure must never fail the share delete
  }
}

// The real upstream hop to Prix. Overridable in tests (like verifyPhoenixToken)
// so the generated Worker's derivation/gating is exercised against a simulated
// backend without a live network.
async function defaultCollabFetch(request) {
  return fetch(request);
}
`;
}
