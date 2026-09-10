---
name: secrets
description: "Manage named bundles of environment variables backed by the OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager). Create bundles, add secrets, generate passwords, and inject them into agent runs. Triggers on: 'API key', 'credentials', 'secrets bundle', 'inject env vars', '--secrets', 'keychain', 'credential manager'."
argument-hint: "[create|add|list|view|import|export|rotate|generate]"
allowed-tools: Bash(agents secrets*), Bash(secrets*)
user-invocable: true
---

# Secrets

Store credentials in the OS keychain and inject them into agent runs. The engine is the standalone **`secrets` CLI** (`@phnx-labs/secrets-cli`). `agents secrets` is a passthrough to the same binary. agi-cli does not ship the engine.

## Install

```bash
agents clis install secrets
# or: npm i -g @phnx-labs/secrets-cli@0.1.2
# or: agents setup secrets
```

No extra environment variables. After install, `secrets --version` prints `0.1.2`.

The macOS broker is `secrets _agent-run`, not `agents daemon`. Socket: `$SECRETS_HOME/.cache/helpers/secrets-agent/`.

Store credentials in your OS keychain and inject them into agent runs. Nothing touches disk in plaintext — not even the bundle metadata.

## Platform support

| Platform | Backend | Install |
|----------|---------|---------|
| macOS | Keychain | Built-in |
| Linux (desktop) | GNOME Keyring (libsecret) | `sudo apt install libsecret-tools` |
| Linux (headless/server) | Use `env:` refs | See below |
| Windows | Credential Manager (primary) + encrypted-file fallback | Built-in |

**Desktop Linux:** GNOME Keyring (or another Secret Service provider) must be running. Most desktop environments start it automatically.

**Headless Windows (service accounts, SSH with no interactive logon):** Credential Manager needs a logon session; without one it fails with `ERROR_NO_SUCH_LOGON_SESSION` (1312) and secrets transparently route to the AES-256-GCM encrypted-file store. Set `AGENTS_SECRETS_PASSPHRASE` so that store has an off-disk key — otherwise a machine-local key is provisioned next to the ciphertext.

**Headless Linux (SSH, CI, containers):** No keyring daemon available. Use `env:` refs to pass secrets via environment:

```bash
# Create bundle with env refs
agents secrets create prod
agents secrets add prod DB_PASSWORD --env DB_PASSWORD

# Pass at runtime
DB_PASSWORD=xxx agents run claude "..." --secrets prod
```

1Password is already supported (`import --from 1password:<vault>`, `export --to-1password`) — see below. AWS Secrets Manager and HashiCorp Vault providers remain planned.

## Why not just use .zshrc or 1Password?

**Environment variables in .zshrc**: The agent inherits your *entire* environment. You can't scope what it sees — it gets everything, including keys for services it doesn't need. And they're plaintext on disk.

**1Password / iCloud Passwords**: Designed for humans, not agents. They require interactive authentication (biometrics, master password). An agent can't programmatically fetch or store credentials without you approving each access. And they can't *write* — if an agent generates a new API key, it can't save it back.

**agents secrets**: Scoped bundles (agent only sees what you pass), OS keychain-backed (encrypted at rest), and agent-friendly (agents can read *and* write programmatically).

## "I need to give an agent access to my API keys"

Create a bundle, add your keys, then pass the bundle when running agents:

```bash
agents secrets create prod
agents secrets add prod STRIPE_API_KEY      # prompts for value
agents secrets add prod DATABASE_URL

agents run claude "deploy the api" --secrets prod
```

The secrets inject as environment variables at runtime.

## "I just generated a new API key in the browser — how do I save it?"

Pipe it via stdin so it never appears in shell history:

```bash
echo "$NEW_API_KEY" | agents secrets add prod STRIPE_KEY --value-stdin
```

## "I need a secure password"

```bash
agents secrets generate --copy    # copies to clipboard, prints nothing
```

## "I have multiple machines and want secrets to sync"

Move a bundle between machines with `push`/`pull` — it's encrypted, uploaded to
`api.prix.dev`, and decrypted back into the local keychain/file store on the
other end:

```bash
# On one machine:
agents secrets create work
agents secrets add work SOME_KEY
agents secrets push work

# On another machine:
agents secrets pull work      # work now exists locally too
```

A bundle created with `--synced` instead stores it in an age-encrypted local
file (`$SECRETS_HOME/vault.age`) that you sync yourself (e.g. via a synced
folder) rather than through `api.prix.dev`.

## "I want to track when API keys expire"

Add metadata when storing secrets:

```bash
agents secrets add prod STRIPE_KEY --type api-key --expires 2027-12-31 --note "Live key, rotate annually"
```

The `list` command shows secrets expiring in the next 30 days. Expired secrets show in red.

## "I have multiple accounts on one website"

For browser logins, name the bundle after the domain — `x.com`, `linkedin.com`, `reddit.com` — and group keys by account handle. One bundle per site, any number of accounts inside. Every account carries a `--note` saying when to use it:

```bash
agents secrets create x.com --description "X/Twitter accounts. Read key notes to pick the right one."

agents secrets add x.com ZEFFMUKS_USERNAME --value zeffmuks \
  --note "Personal account. Casual engagement, memes."
agents secrets add x.com ZEFFMUKS_PASSWORD --type password \
  --note "Password for @zeffmuks"

agents secrets add x.com SOCIAL_GETRUSH_USERNAME --value social@getrush.ai \
  --note "Official Rush brand account. Product marketing, announcements, replies as Rush."
agents secrets add x.com SOCIAL_GETRUSH_PASSWORD --type password \
  --note "Password for social@getrush.ai"
```

Key naming: uppercase the handle, replace non-alphanumerics with `_`, suffix with `_USERNAME` / `_PASSWORD` (plus `_TOTP_SECRET` if the account has 2FA).

To pick an account, run `agents secrets view x.com` — notes print in the clear while values stay masked, so you can read the key names and choose the right account without seeing any value. Then inject just that pair into the command that needs it — never print it:

```bash
agents secrets view x.com                  # read notes, choose the account
agents secrets exec x.com --keys SOCIAL_GETRUSH_USERNAME,SOCIAL_GETRUSH_PASSWORD -- ./login-helper
```

## "I have a .env file I want to import"

```bash
agents secrets import prod --from .env.prod
```

Every key goes into Keychain. The same `--from` axis imports from other
sources: `--from 1password:<vault>` (needs the `op` CLI) and `--from icloud`.

## "A bundle exists in Keychain Access but `secrets list` can't see it"

Bundles from the pre-biometry era live in the iCloud Keychain and are invisible
to every modern query. Recover them (macOS):

```bash
agents secrets import --from icloud            # interactive multi-select
agents secrets import <bundle> --from icloud   # one specific bundle
agents secrets import --from icloud --purge    # also delete the iCloud copies
```

## "I need a secret that reads from a file or command at runtime"

Secrets can be dynamic references, not just static values:

```bash
agents secrets add prod AWS_TOKEN --exec "aws sts get-session-token --query Credentials.SessionToken"
agents secrets add prod CERT --file /path/to/cert.pem
agents secrets add prod LOG_LEVEL --env LOG_LEVEL
```

(Exec refs require creating the bundle with `--allow-exec`.)

## "Touch ID pops on every run — especially with multiple agents"

macOS prompts Touch ID **per bundle, per process**, so running several agents at once (`agents teams`, parallel `agents run --secrets`) re-prompts once each. There's no OS setting to quiet it — but the **secrets-agent** does (macOS only):

```bash
agents secrets unlock prod        # one Touch ID; held ~7 days (default)
agents teams start my-feature     # every teammate reads prod silently
agents secrets status             # what's held, and when it locks
agents secrets lock               # wipe it; next read re-prompts
```

`unlock` reads the bundle once and keeps the resolved values in a local broker behind a user-only socket; later runs read from memory with no prompt. The hold ends on its TTL (**default 7 days**, `--ttl 30m` to shorten), when you `lock`, or when the machine **sleeps / you log out**. A bare **screen-lock does NOT drop the hold** (it's already gated by the login session). Nothing is written to disk.

### When does Touch ID actually appear?

On a **locked** keychain bundle:

| You run | Touch ID? |
|---|---|
| `secrets list`, `secrets view` (no `--reveal`) | never — metadata / masked values only |
| `secrets view --reveal`, `secrets exec` **at your terminal, outside an agent session** | one sheet, then reveals / runs (a deliberate human reveal/run) |
| `secrets get <item>`, `secrets export` (`--to-file` / `--to-1password`) | **never** — automation primitives; fail fast to `agents secrets unlock` instead. `export` with no destination flag refuses outright and names `exec` / `view --reveal`; the raw-item `get <item>` stays available everywhere (shell hooks inside agent sessions depend on it — a single ad-hoc token is the accepted narrower residual) |
| `secrets unlock` | one sheet — the deliberate unlock |
| anything an **agent** launches (`AGENTS_RUNTIME`) or any no-TTY context | never — resolves broker-only, fails fast if not held |
| anything on an **already-unlocked** bundle | never — served from the broker |

So a sheet only ever appears for a deliberate human action (`unlock`, or a `view --reveal` / `exec` you type) on a *locked* bundle. `get`/`export` stay silent so they never block a script mid-pipeline — `export` now also refuses without a real destination (`--device` / `--to-1password` / `--to-file`), so it never prints a bundle to stdout.

For a machine running lots of agents, run `agents secrets start` once to bring the broker up ahead of time, so a cold-started broker can't get starved under load. `agents secrets status` shows what's held and when it locks.

**You usually don't need `unlock` at all** — a bundle's default prompt policy is
`hold` (ask once per hold window, `secrets.agent.holdMs` — 7d by default), so the
FIRST read of a run already populates the broker and every read after that in
the same window is silent:

```bash
agents secrets policy prod             # show the current policy
agents secrets policy prod always      # switch to "ask every time" instead
```

`always` re-prompts on every read — reach for it on a high-value bundle where
every access should be confirmed. `never` is silent with NO biometry ACL at
all (`--i-understand` required to create one) — never put a high-value secret
there. While a bundle is held, any process running as you can read it from the
socket without a prompt; that's the trade-off, so keep hold windows short and
`lock` when you step away.

## "Which bundles do I actually use, and when was one last touched?"

Every create / import / export / view / access / unlock is recorded value-free (bundle
name, event kind, count, agent — never a value) through one chokepoint, and surfaced
three ways:

```bash
agents secrets view stripe.com          # usage summary + held state + per-agent
agents secrets list --sort uses         # most-accessed bundles first
agents secrets list --sort used         # most-recently-used first
agents secrets activity stripe.com      # recent event timeline (last 90 days)
```

`agents secrets view` prints e.g. `usage: accessed 42× (last 2h ago) · exported 3× (last
1d ago)`. The full audit trail is `agents events --module secrets`. Disable recording
with `AGENTS_NO_USAGE_TRACK=1`.

## "How should I name a bundle?"

Name it after what it holds, so an agent can guess it without listing — a website by its
domain with the real suffix (`stripe.com`, `openai.ai`, `github.com`), a desktop app by
its binary suffix (`slack.app`, `photoshop.exe`). Always pass `--description`; an
undescribed bundle prints a "No description found" nudge in `list` / `view` / `create`.

```bash
agents secrets create stripe.com --description "Stripe live + test API keys"
```

## "What else can I do?"

Run `agents secrets --help` — there's more: viewing/revealing values, rotating secrets with preserved metadata, exporting to shell, organizing by environment or service.
