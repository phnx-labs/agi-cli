/**
 * `agents sessions bookmark` — the non-TTY half of the bookmark hotkey.
 *
 * The `*` hotkey in the interactive browser is how a human bookmarks a session;
 * this is how a script, an agent, or a machine without a TTY does the same thing,
 * and it is what makes the feature testable end to end without driving a terminal
 * UI. Both write the one store in `lib/session/bookmarks.ts`.
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { findSessionsById } from '../lib/session/db.js';
import { isCompleteSessionId } from '../lib/session/discover.js';
import { isBookmarked, listBookmarks, setBookmark } from '../lib/session/bookmarks.js';

interface BookmarkOptions {
  remove?: boolean;
  list?: boolean;
}

/**
 * Resolve one user-typed id (usually the 8-char short id the listing prints) to
 * a full session id. Ambiguity is an ERROR, not a silent first-match: bookmarking
 * the wrong session is invisible until the user wonders where their bookmark went.
 */
function resolveBookmarkTarget(idQuery: string): { id: string } | { error: string } {
  const matches = findSessionsById(idQuery);
  // A COMPLETE id needs no index entry: the id is the key the store is built on,
  // and requiring a transcript row would refuse exactly the newest sessions — a
  // live one that has not been indexed yet. The browser's `*` bookmarks those
  // from the live row, so demanding a DB hit here would make the two disagree.
  if (matches.length === 0) {
    return isCompleteSessionId(idQuery.trim())
      ? { id: idQuery.trim() }
      : { error: `No session matches "${idQuery}".` };
  }
  if (matches.length > 1) {
    const ids = matches.slice(0, 5).map((m) => m.shortId).join(', ');
    return { error: `"${idQuery}" matches ${matches.length} sessions (${ids}…) — use a longer id.` };
  }
  return { id: matches[0].id };
}

export function registerSessionsBookmarkCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('bookmark')
    .argument('[ids...]', 'Session ids to bookmark (full or short id prefix)')
    .description('Bookmark sessions so they are easy to find again — list them with --bookmarks, or `b` in the browser.')
    .option('--remove', 'Remove the given sessions from bookmarks instead of adding them')
    .option('--list', 'List the bookmarked sessions (the default when no ids are given)')
    .option('--json', 'Output JSON');

  setHelpSections(cmd, {
    examples: `
      # Bookmark a session by its short id (the 8 chars the listing prints)
      agents sessions bookmark 26c27162

      # See what is bookmarked
      agents sessions bookmark --list

      # Browse only the bookmarked ones
      agents sessions --bookmarks

      # Remove it from bookmarks again
      agents sessions bookmark 26c27162 --remove
    `,
    notes: `
      In the interactive browser (\`agents sessions\`), \`*\` bookmarks the highlighted
      session and \`b\` filters the list down to the bookmarked ones.

      Bookmarks live in ~/.agents/.history/bookmarks.json, keyed by session id, so
      they survive a reindex of the session cache. They are per-machine: session
      sync carries transcripts, not this file.
    `,
  });

  cmd.action((ids: string[], options: BookmarkOptions, self: Command) => {
    // `--json` has to come from the merged view, not `options`. The parent
    // `sessions` command declares `--json` AND takes a positional `[query]`, so
    // commander keeps parsing parent-known options past the subcommand name and
    // binds `--json` to the PARENT — `options.json` is silently undefined here
    // while `--remove`/`--list` (unknown to the parent) arrive fine.
    // `optsWithGlobals` is commander's own answer for reading an option a parent
    // owns; it is still declared on this command so `--help` documents it.
    const json = (self.optsWithGlobals() as { json?: boolean }).json === true;
    if (options.list || ids.length === 0) {
      const bookmarked = [...listBookmarks()].sort();
      if (json) {
        process.stdout.write(JSON.stringify({ bookmarks: bookmarked }, null, 2) + '\n');
        return;
      }
      if (bookmarked.length === 0) {
        console.log(chalk.gray('No bookmarked sessions. Bookmark one with `agents sessions bookmark <id>`.'));
        return;
      }
      for (const id of bookmarked) console.log(`${chalk.yellow('★')} ${id}`);
      console.log(chalk.gray(`\n${bookmarked.length} bookmark${bookmarked.length === 1 ? '' : 's'}.`));
      return;
    }

    const on = !options.remove;
    const results: { query: string; id?: string; bookmark?: boolean; error?: string }[] = [];
    for (const idQuery of ids) {
      const resolved = resolveBookmarkTarget(idQuery);
      if ('error' in resolved) {
        results.push({ query: idQuery, error: resolved.error });
        continue;
      }
      // Removing a bookmark that does not exist, or bookmarking it twice,
      // is a no-op the store already short-circuits — report the resulting state.
      setBookmark(resolved.id, on);
      results.push({ query: idQuery, id: resolved.id, bookmark: isBookmarked(resolved.id) });
    }

    if (json) {
      process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
    } else {
      for (const r of results) {
        if (r.error) console.error(chalk.red(r.error));
        else console.log(`${r.bookmark ? chalk.yellow('★ bookmarked') : chalk.gray('☆ unbookmarked')} ${r.id}`);
      }
    }
    // A failed lookup is a failed command — a script must not read "bookmarked"
    // from a zero exit when nothing was bookmarked.
    if (results.some((r) => r.error)) process.exitCode = 1;
  });
}
