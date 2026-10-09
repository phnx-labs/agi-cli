
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

function resolveBookmarkTarget(idQuery: string): { id: string } | { error: string } {
  const matches = findSessionsById(idQuery);
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
      sessions bookmark 26c27162

      # See what is bookmarked
      sessions bookmark --list

      # Browse only the bookmarked ones
      sessions --bookmarks

      # Remove it from bookmarks again
      sessions bookmark 26c27162 --remove
    `,
    notes: `
      In the interactive browser (\`sessions\`), \`*\` bookmarks the highlighted
      session and \`b\` filters the list down to the bookmarked ones.

      Bookmarks live in ~/.agents/.history/bookmarks.json, keyed by session id, so
      they survive a reindex of the session cache. They are per-machine: session
      sync carries transcripts, not this file.
    `,
  });

  cmd.action((ids: string[], options: BookmarkOptions, self: Command) => {
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
    if (results.some((r) => r.error)) process.exitCode = 1;
  });
}
