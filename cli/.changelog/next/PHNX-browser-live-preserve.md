- **Replacing the browser daemon no longer kills a live browser (PHNX-3999).** The
  daemon's startup reaper read "the daemon that launched this has exited" as "everything
  it recorded is garbage" and SIGTERMed the browser — so activating the menu bar,
  upgrading, or a daemon crash-restart closed a browser you were looking at, and the
  runtime record was wiped so the survivor could not even be re-attached. But a live
  browser outliving its daemon is the normal case: shutdown deliberately closes only
  CDP, and on macOS the browser is spawned detached. A live local browser is now
  preserved untouched, a dead record is cleared without signalling anything, and a
  stale `ssh -L` tunnel — which genuinely cannot outlive its owner — is still reaped,
  decided separately from the browser instead of sharing one kill path. Ownership of a
  preserved browser transfers only after an identity-checked attach succeeds — including
  the restart path that restores your open browser tasks — and that rewrites the
  owning-daemon pid alone, keeping the original launch's metadata. Source:
  `cli/src/lib/browser/runtime-state.ts`.
