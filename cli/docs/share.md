# Share — identity, namespace, and visibility

`agents artifacts share` publishes an HTML artifact (a plan, a viz, a report) to a
world-reachable link. This document is the model behind that link: **who you are
when you publish, what namespace the link lands in, and who can then read it.** For
command syntax use `agents artifacts share --help` or the
[command index](command-index.md); for onboarding use the product README.

There are two backends — a **managed** endpoint you get for free by signing in, and
a **BYO** Cloudflare R2 + Worker you provision yourself. The publication boundary
(bearer-gated writes, public reads) is described in
[observability.md](observability.md); this document covers the identity and
visibility model that sits on top of it.

## One identity: Phoenix ID

There is a **single** account behind the managed endpoint: a **Phoenix ID**. It is
the only identity agents-cli authenticates against — there is no separate "GetRush"
account and no Supabase user. `PhoenixSession` and the API base are the whole
surface (`src/lib/identity/client.ts:31` `PHOENIX_ID_BASE`, `:39`
`interface PhoenixSession`).

Sign-in is **Google-only**, over the RFC 8628 device-code flow: `agents auth login`
opens a Phoenix-branded page and the CLI never sees a password
(`src/commands/auth.ts:131` — "Sign-in is Google-only and opens a Phoenix-branded
page; the CLI never sees a password"). On approval the CLI writes the session —
`{ access_token, email, userId, avatarUrl? }` — to disk (`src/commands/auth.ts`
`writeSession(...)`; `avatarUrl` is the hosted OAuth profile image, when Phoenix
exposes one). Every managed share request carries that session's bearer.

A signed-in user publishes to `share.agents-cli.sh/<handle>/<slug>` with the
Phoenix session and **no Cloudflare account, bucket, or write token**. Without a
session, the BYO Cloudflare path applies instead (`agents artifacts setup` /
`agents artifacts share join`), gated by a static `WRITE_TOKEN`.

## Namespace = the email local-part

The URL namespace (the `<handle>` segment) is the **local-part of the signed-in
email** — everything before the `@`, with any `+tag` dropped:

- `muqsitnawaz@gmail.com` → `muqsitnawaz`
- `muqsitnawaz+dev@gmail.com` → `muqsitnawaz`

`handleFromEmail` derives it (`src/lib/share/backend.ts:81`), and it must match the
Worker's own `handleFromEmail` so the CLI and the endpoint agree on the same
namespace. When the email is missing it falls back to a sanitized `userId`
(`backend.ts:90`). On the BYO path the namespace is instead the resolved GitHub
username (gh / `git config` / `--for-user`).

### Handle collisions and account moves (PHNX-3547)

The Worker binds each handle to the first Phoenix userId that writes it
(`__handles/<handle>` claim, `src/lib/share/worker-template.ts`) and records the
verified email on the claim:

- **Different person, colliding local-part** → `409 handle taken`, permanently.
  The recovery path is `--handle <name>` — an explicit alternate namespace
  (`x-share-handle` header), bound with the same first-writer claim. The owner of
  a claimed handle (derived or alternate) can always PATCH and DELETE under it —
  including pages whose `owner` stamp is not their userId (a fleet `SHARE_WRITE_TOKEN`
  publish stamps `owner = <namespace>`; a pre-stamp page has none). The claim is the
  authority on both routes; neither compares the per-object stamp, and PATCH leaves
  the stamp untouched because the anonymous expiry path refunds the *stamped*
  owner's usage ledger and a fleet/BYO page was never charged to a Phoenix one.
- **Same human, new account** — a re-login that mints a NEW userId for the SAME
  verified email — transfers the handle instead of dead-ending: the claim re-binds
  to the new userId and every object the old userId owned under the prefix is
  re-stamped, so existing shares keep working. Claims written before the claim
  recorded an email cannot prove this and keep the permanent 409.

Also on the Worker: a concurrent republish is a bounded compare-and-swap loop
(`onlyIf.etagMatches`, the same primitive the PATCH path and the usage ledger use)
instead of an unconditional read-copy-write — a losing writer 409s the put,
re-reads, archives the winner's body as a revision, and lands its own canonical,
so no accepted body is silently discarded.

## Visibility levels

A publish stamps exactly one of five visibility levels on the stored object
(`src/lib/share/publish.ts` `type ShareVisibility = 'public' | 'unlisted' |
'private' | 'me' | 'org'`; the publish-selectable ordered set is
`PUBLISH_VISIBILITY_LEVELS`, and the in-place re-scopeable subset is
`SHARE_VISIBILITY_LEVELS`). `--visibility <level>` selects it. With no flag the
default is **private**: `publishVisibility` (`src/lib/storage/visibility.ts`, the
shared model both this surface and `sessions` backup consume) stamps `me` on a
managed (signed-in) publish and `public` on a BYO one — the Worker refuses
`me`/`org` for a WRITE_TOKEN publish, so BYO has no Phoenix owner to gate on. The
`commands/share.ts` action applies that default; the library
`resolveShareVisibility` fallback deliberately stays `public` so a caller that
expresses "public" as the absence of `--unlisted` (e.g. `sessions share --public`)
is never silently flipped. `resolveShareVisibility`/`explicitVisibility` resolve
the flag plus the aliases below.

| Level | Who can read | In the gallery? | Robots | Requires |
|---|---|---|---|---|
| `me` (default when signed in) | only the signed-in owner | no | `noindex`, `private, no-store` | Phoenix session |
| `public` (default for BYO) | anyone with the link | **yes** — listed, gets an OG preview card | indexable | — |
| `unlisted` | anyone with the link (capability URL — obscurity, **NOT** authentication) | no | `X-Robots-Tag: noindex` | — |
| `private` | anyone with the link **and its viewer key** (token-gated; `404` without a matching key) | no | `noindex`, `private, no-store` | — (works for BYO too) |
| `org` | anyone at the sharer's email **domain** | no | `noindex`, `private, no-store` | Phoenix session + a workspace domain |

Managed HTML shares always advertise `<slug>.png` as their Open Graph image. The
Worker lazily renders that first request as a deterministic 1200×630 AGI card
from the page title, description, handle, and visibility, then caches the PNG in
R2. The cover passes through the canonical page's visibility gate before render,
so `me`/`org` metadata cannot leak. No browser is launched on the publishing
machine. `agents artifacts share update` uploads Yoga and resvg as compiled WASM
modules beside the Worker's JavaScript; workerd forbids compiling inlined WASM
bytes at request time. A renderer initialization failure returns a diagnostic
`500` and does not cache a missing/broken cover. BYO endpoints retain the local
Chromium screenshot fallback because their independently hosted Worker may
predate the renderer.

- **`unlisted` is a capability URL, not a secret — it is NOT read-authentication.**
  GET still returns 200 to anyone with the link; it is only hidden from the
  gallery/listing and marked `noindex`. The CLI prints a loud stderr warning to
  that effect on every `unlisted` publish and points at `--protected` / `--expire`
  (PHNX-3654, `unlistedNotPrivateWarning`). `--private` and `--unlisted` are hidden
  aliases of `--visibility unlisted` (`resolveShareVisibility` maps `unlisted:true`
  → `'unlisted'`). An `unlisted` (and `private`) publish also **forces a 64-bit
  random slug tail** when no explicit `--slug` is given, so the capability URL can
  never be guessed from the artifact title.
- **`private` is token-gated read-auth (PHNX-3654) — the real fix for a
  world-readable "private" share.** `--protected` (= `--visibility private`) mints a
  random viewer token; the CLI sends the RAW token in `x-share-viewer-token` and the
  Worker stores only its **SHA-256 hash** in `customMetadata['viewer-token-hash']`,
  so the secret never lands in object metadata. The published URL carries the key —
  `https://<host>/<user>/<slug>?k=<token>`. The Worker serves a `private` object
  only to a request whose `?k=` (or `Authorization: Bearer`) hashes to the stored
  value under a constant-time compare (`safeEqual`); any miss returns `404` (never
  `401`), so a token-gated page never even leaks that it exists. The page, its
  generated OG cover, and its `?revisions=json` list are all gated, and both the
  page and the generated cover are served `Cache-Control: private, no-store` plus
  `X-Robots-Tag: noindex` so a shared cache cannot reuse a Bearer fetch of
  `/user/slug.png` for a later unauthenticated request (PHNX-3676). The namespace
  owner (signed-in, `owner === identity.userId`) reads their own private page
  without the key, so `share open` still works. `private` works for a BYO
  `WRITE_TOKEN` endpoint too (the gate is the token, not an identity). It can only
  be set **at publish time** — the in-place `share visibility` / PATCH route rejects
  it with a `400`, since re-scoping in place carries no fresh key.
- **`me` and `org` are identity-gated reads**, enforced at the Worker. An
  unauthenticated request for either 302-redirects to the Phoenix login
  (`gateRestrictedGet` → `bounceToLogin`, `worker-template.ts:875`, `:901`). A
  wrong viewer gets a `404`, so a restricted page never even leaks that it exists.
- `me` reads require the viewer's `userId` to equal the object's stamped `owner`
  (`viewerMayRead`), **or** to hold the namespace's `__handles/<handle>` claim
  (`gateVisibility` → `holdsHandleClaim`) — the same authority PATCH/DELETE use, so
  the owner who hides a fleet-token-published page (stamped `owner = <namespace>`)
  can still read it. `org` reads require the viewer's
  email **domain** to equal the `org_domain` stamped at publish time
  (`worker-template.ts:893`; stamped from `emailDomain(auth.email)` at `:162` /
  `:252`).
- `me`/`org` are Phoenix-only. A BYO `WRITE_TOKEN` can publish `public`/`unlisted`
  only — the Worker rejects `me`/`org` from a non-Phoenix caller with a `400`
  (`worker-template.ts:94`–`97`). On the initial `share <file>` **publish** path
  the CLI sends the visibility header unconditionally and surfaces the Worker's
  raw `400` with a generic "check the write token / `agents artifacts setup`"
  message (`publish.ts:770`) — no login pre-check. The in-place **`share
  visibility`** edit path (below) is the one that pre-checks and emits a crisp
  `agents auth login` hint before the round trip (`runShareEdit`, `share.ts:187`).

### `org` rejects public-inbox domains — the sharp edge

`org` means "anyone at **my** email domain", and the domain is derived from the
**sharer's own email**, never from any configured value. That only makes sense for a
real workspace domain, so the Worker **refuses `org` on a public-inbox domain**:

```
PUBLIC_INBOX_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com',
                        'hotmail.com', 'live.com', 'icloud.com', 'me.com']
```

(`src/lib/share/worker-template.ts:610`). Publishing `org` from one of these returns
`400 "org visibility cannot use a public email domain"` (`worker-template.ts:102`,
and the same check on the in-place edit path at `:246`). So an `org` share is
possible **only when you are signed in with a workspace-domain Google account**
(e.g. `you@yourcompany.com`) — never with a personal `gmail.com` / `icloud.com`
address. A page that reads "Anyone at yourcompany.com" derives `yourcompany.com`
from the signer's email, not from a setting.

An empty/unverifiable domain is likewise refused (`400 "org visibility requires a
verified email domain"`, `worker-template.ts:101`).

Every HTML page also carries an always-on **attribution bar** injected at serve
time that shows the visibility as a visual cue; `?raw` does not strip it
(`worker-template.ts:366`). The sharer's photo in the bar prefers the hosted
OAuth profile image (`PhoenixSession.avatarUrl`, refreshed from
`/api/v1/auth/me` — `refreshSessionAvatar`) and falls back to an email-keyed
Gravatar (`d=404`) and then initials only when no hosted image exists
(`resolveShareAvatar`, PHNX-3547).

The bar also carries a right-side **stats cluster** — `👁 <n> views · updated
<rel>` — and, for the page **owner**, a **live visibility control**
(`renderAttributionBar`, `worker-template.ts`):

- **Views** are a per-slug visitor count kept in a **separate** R2 object at
  `__views/<user>/<slug>`, incremented on each canonical HTML page view via
  `ctx.waitUntil` so it never blocks the response and never rewrites the page
  object (a rewrite would reset `uploaded` and corrupt "last updated"). The
  owner's own views and `?raw`/embed fetches are **not** counted, so the number
  reflects real visitors. The `__`-prefix key is GET-blocked for direct requests
  and lives outside every `<user>/` list prefix, so it never appears in the
  gallery, JSON listing, or revisions (`readViews`/`writeViews`,
  `worker-template.ts`).
- **Last updated** is the object's `uploaded` timestamp rendered as a compact
  relative time ("just now" / "2h ago" / "3d ago" / an ISO date past ~30 days).
- **Owner control.** When the requesting viewer OWNS the namespace — resolved
  with the existing `resolveViewer` and `handleFromEmail(viewer.email) ===`
  the namespace handle — the visibility chip becomes an inline dropdown of the
  four levels. Selecting one PATCHes the **same in-place edit route** as
  `share visibility` (JSON `{ visibility }` body) with `credentials:'include'`,
  so the viewer's `__share` cookie / Phoenix identity authenticates it
  (`authorizeWrite` accepts that HMAC-signed cookie as a write principal; it is
  `SameSite=Lax`, so it can't ride a cross-site PATCH). The chip flips
  optimistically with a spinner, then a green check on success or reverts and
  shows the **server's** error text on failure (e.g. org from a public-inbox
  domain 400s). Everyone else keeps the static read-only cue.

All of this is a pure Worker-template change, so a deployed endpoint reads
`outdated` until its owner redeploys with `agents artifacts share update` (no new
bindings — it reuses R2 and the existing PATCH route).
`agents artifacts share update --check [--update-json]` reports whether a redeploy
is due — a pure local render+hash that reads no Cloudflare credentials — without
deploying.

For the **managed** endpoint (`share.agents-cli.sh`, operated by us), this redeploy
no longer waits on a manual run: `cli/scripts/release.sh` runs it automatically after
publish when `worker-template.ts` changed (`--deploy-worker auto|on|off`, default
`auto`; PHNX-3403), so a release can't ship a template change while prod keeps
rendering the old card — the gap that made PHNX-2835 look shipped while every new
share still 404'd its cover. See the *Releasing* section of
[`cli/AGENTS.md`](../AGENTS.md#releasing). BYO endpoints still redeploy on their own
owner's `share update`.

## Listing hidden pages — `share list --scope` / `--all`

By default `agents artifacts share list` mirrors the **public gallery** — it lists
public pages only (`--scope public`). To see your hidden pages, name a hidden scope:

```bash
agents artifacts share list                 # public only (default)
agents artifacts share list --all           # every page, incl. unlisted/private/me/org (alias for --scope all)
agents artifacts share list --scope me      # just your owner-only pages
agents artifacts share list --scope unlisted # just your capability-URL pages
agents artifacts share list --scope org     # just your org pages
```

`--scope <level>` takes `public` (default), `unlisted`, `me`, `org`, or `all`;
`--all` is the convenience alias for `--scope all` (`src/commands/share.ts:1081`–
`1089`). The filter is named `--scope` (not `--visibility`) because the parent
`share <file>` command already owns `--visibility` and Commander resolves an
option's long name against the whole ancestor chain (`share.ts:1077`–`1079`).

Any hidden scope sends the **owner's bearer** and a `scope=mine` hint to the
Worker's JSON listing route (`runShareList`, `src/commands/share.ts:349`–`362`); the
Worker returns hidden pages **only after verifying the bearer owns the namespace**
(`resolveListingScope`, `worker-template.ts:551`). Each human row shows the page's
visibility so public vs hidden is obvious at a glance
(`formatShareList`, `share.ts:459`–`460`). A BYO Worker that predates the listing
route fails loud and points at `agents artifacts share update` rather than returning
a wrong-or-empty result (`OUTDATED_TEMPLATE_HINT`, `share.ts:225`).

## Changing visibility in place — `share visibility <target> <level>`

`agents artifacts share visibility <target> <level>` re-scopes an
**already-published** page without re-publishing it:

```bash
agents artifacts share visibility https://share.agents-cli.sh/octocat/q3-plan me
agents artifacts share visibility octocat/q3-plan public
agents artifacts share visibility q3-plan org      # rejected on a public-inbox domain
agents artifacts share visibility q3-plan me --visibility-json
```

`<target>` accepts the same three forms as `unshare` — a full URL, `<user>/<slug>`,
or a bare slug in your namespace; `<level>` is one of `public | unlisted | me | org`
(the `SHARE_VISIBILITY_LEVELS` subset). `private` is deliberately NOT re-scopeable in
place — token-gating needs a fresh viewer key that only a publish mints, so the
route rejects `private` with a `400` and points at `share <file> --protected`
(PHNX-3654). It **re-stamps only the visibility** on the
stored object via the same `PATCH` metadata-edit route as `share edit` — the slug
(and so the URL) is preserved, and the body, provenance, label, and `--meta` are
untouched, so **like `share edit` it creates no revision** (`runShareEdit`,
`share.ts:160`, `:196`). Visibility is a first-class edit field alongside `label`,
never a `--meta` entry (`visibility` is reserved).

The result flag is `--visibility-json` (not `--json`), the same ancestor-collision
rename as `--scope`/`--for-user` above (`share.ts:944`). The same gates apply as at
publish time: `me`/`org` require a Phoenix session and fail loud with an
`agents auth login` hint when signed out (`share.ts:187`), and `org` is refused on a
public-inbox domain (`worker-template.ts:246`). A BYO endpoint whose deployed Worker
predates the visibility edit **fails loud** — it 200s without echoing `visibility`
back, which the CLI detects and turns into an `agents artifacts share update` hint
rather than a silent no-op success (`share.ts:211`–`217`).

## Changing visibility in the browser — `share open <target>`

The served page carries an **inline visibility control** — the `Public`/`Unlisted`/…
chip in the attribution bar is an interactive dropdown, but **only for the signed-in
owner**. `isOwner` is `handleFromEmail(identity.email) === firstSeg` (`worker-template.ts:425`),
and a browser gets that identity only from the `__share` cookie, which the Worker sets
by redeeming a `?phoenix_ticket=` on one navigation (`resolveViewer`,
`worker-template.ts`). Opening your own link directly (bookmark, pasted URL) carries no
cookie, so the chip renders as a static cue.

`agents artifacts share open <target>` closes that loop:

```bash
agents artifacts share open q3-plan                 # open, signed in, chip is live
agents artifacts share open octocat/q3-plan
agents artifacts share open q3-plan --no-open       # print the ticketed URL instead
```

It `POST`s your Phoenix bearer to `<base>/__ticket`, where the Worker mints a
**short-lived (120 s), single-use, self-signed** login ticket — signed with the same
HMAC secret as the cookie but **domain-separated** (`ticket:`-prefixed payload) so a
ticket can never be replayed as a cookie or vice versa (`signSelfTicket` /
`verifySelfTicket`, `worker-template.ts`). The CLI appends it as `?phoenix_ticket=`;
the Worker verifies it locally (no external ticket service), sets the `__share` cookie,
and 302s the ticket back off the URL. The ticket grants nothing the caller's bearer
didn't already prove. Managed (Phoenix) endpoints only — a BYO/`WRITE_TOKEN` endpoint
has no per-viewer login, so `share open` fails loud pointing at
`agents artifacts share visibility` instead. A Worker deployed before this feature 501s
the mint, which the CLI turns into an `agents artifacts share update` hint
(`share.ts` `runShareOpen`).

## Quotas & limits — managed publishing (PHNX-3542)

The managed endpoint (`share.agents-cli.sh`) is shared infrastructure, so a
Phoenix-identity publish is metered per user. Every authenticated PUT is charged
against a per-user usage ledger — a single R2 object at `__usage/<owner>`, updated
with a conditional-put compare-and-swap loop (the same primitive the metadata-edit
PATCH uses; no Durable Object, no extra binding). The **free** tier:

| Limit | Free tier | Over-limit response |
|---|---|---|
| Total stored bytes | 200 MiB | `413` `storage limit reached` |
| Canonical pages | 150 | `413` `artifact limit reached` |
| Per-file size | 20 MiB | `413` `file too large` |
| Publishes per hour | 60 | `429` `rate limit …` (+ `Retry-After`) |

Enforcement measures the **real request body**, never a client-declared size: the
Worker buffers the body bounded by the per-file cap (so a chunked/streaming body
can never buffer past the cap) and checks the per-file and total-byte limits on the
true size **before** any R2 write. A spoofed-low `content-length` therefore cannot
slip an oversized body past the cap, exceed the total quota, or — the dangerous
case — reach the destructive revision-copy + overwrite and destroy the existing
page. The quota counts **canonical pages plus their retained revisions**; a
republish that keeps a revision is charged the full new size (the old bytes stay as
a revision). Server-generated **OG covers and view counters are overhead, excluded
from the quota**. Deleting a page refunds its bytes and object slot; an expired
page is refunded on its lazy delete.

The `SHARE_PLANS` map in `worker-template.ts` is the plan seam — only `free` is
defined today; paid tiers and the field that sets a user's plan arrive with
billing (follow-up). Enforcement is **managed-only**: a **BYO** deployment (a
`WRITE_TOKEN` publish to the operator's own Cloudflare bucket) writes at the
operator's own cost and **skips all four limits** — a deliberate policy, not a
silent gap.

## Collaboration — same-origin human review transport (PHNX-3835)

A managed share can host **human-to-human collaboration** (review comments) on the
artifact itself. The Worker exposes a same-origin `/__collab/*` transport that the
served page's browser JS calls; the Worker proxies each request to the Prix
artifact-collaboration API. The Worker stays the trust boundary exactly as it is
for the page GET:

- **Object-first.** Every `/__collab` request loads the R2 share object **before**
  anything else. A share that was never published, or was just deleted, `404`s —
  so share existence is never enumerable, and a deleted share's comments become
  inaccessible the instant its object is gone (no separate revocation step).
- **Server-derived identity.** The share id (`SHA-256(ownerId + NUL + normalized
  R2 path)`), current revision (the object etag), owner, visibility, org domain,
  and producer provenance (`agent`/`session`/`host`/`repo`) are all re-derived
  **server-side** from R2 metadata. The browser-supplied `share` value is a lookup
  key only, never trusted as identity — a raw private access token is never sent as
  identity.
- **The exact page read gate, denials as 404.** `me`/`org` reuse the identity gate,
  `private` reuses the viewer-token (`?k=`) gate; any denial is a plain `404`
  (never a `302` login bounce or a `401`), so an out-of-scope viewer can't tell the
  share exists. Public/unlisted readers may read **anonymously**; **every write
  requires a verified signed-in Phoenix human**; `private` still requires its share
  token. Visibility is re-checked per request, so a downgrade is immediate.
- **Prix proxy.** Requests forward to `${PRIX_ARTIFACT_COLLAB_BASE}/v1/artifact-collaboration`
  (`GET /context`, `GET /threads?after=`, `POST /threads`, `POST /threads/:id/replies`,
  `PATCH /comments/:id`, `PATCH /threads/:id`, `GET /events`, and a best-effort
  authenticated `POST /purge` on share delete) with the service token
  (`ARTIFACT_COLLAB_SERVICE_TOKEN`) in `Authorization` — **never** surfaced to the
  browser — plus trusted `X-Artifact-*` / `X-Phoenix-Actor-*` headers. The client
  `Idempotency-Key` and `Last-Event-ID` ride through; SSE bodies stream **unbuffered**
  (`X-Accel-Buffering: no`, cancel/disconnect propagated); every collaboration
  response is `no-store`.
- **Fail closed.** Missing `PRIX_ARTIFACT_COLLAB_BASE` or
  `ARTIFACT_COLLAB_SERVICE_TOKEN` disables the whole surface (`404`) **without
  affecting the artifact page GET**. A **BYO** endpoint has no Phoenix identity, so
  managed collaboration correctly does not exist there. The surface stays **dormant**
  until an operator sets both secrets; `agents artifacts share setup` / `update` bind
  them on a managed deploy (both or neither, read from the deploy environment).

The Prix API counterpart owns the durable thread/comment store, notifications, and
future agent mentions/wake-up. No Worker timer, scheduler, durable queue, or
separate pub/sub is added here — the Worker is a pure trust-boundary proxy.

## Related

- [observability.md](observability.md) — the publication boundary (bearer-gated
  writes, public reads) and the traces surface.
- [secrets.md](secrets.md) — the BYO `cloudflare.com` / `WRITE_TOKEN` bundles.
