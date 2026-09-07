- **`agents run` no longer fails with `secrets request failed: spawnSync sh
  ETIMEDOUT` when resolving an account credential.** The synchronous secrets path
  (`agents view`, the account catalog, and account resolution on the `agents run`
  hot path) fed the standalone `secrets __serve` its request over a named FIFO on
  fd 3. The standalone wraps fd 3 in a `net.Socket`, and a Socket over a named FIFO
  reads the request but never fires EOF on macOS — so its read loop blocked until
  the 3s sync bound fired and every credential lookup timed out. The request now
  rides `spawnSync`'s stdin (a real pipe/socketpair — the same fd type the async
  path already hands the standalone) dup'd onto fd 3, so it EOFs and a real
  handshake/lookup completes in tens of ms. Source: `cli/src/lib/secrets-client.ts`
  (`serveOnceSync`).
