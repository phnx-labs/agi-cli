import chalk from 'chalk';
import { compareVersions } from './agent-spec/primitives.js';

/** Render a compact "What's new" from a CHANGELOG.md body: one bullet per feature/fix heading for
 * each version in `(fromVersion, toVersion]`, in both the current `- **Title.** prose` and older
 * `**Heading**` formats. Prose is dropped; returns colored lines, empty if none. */
export function renderWhatsNew(changelog: string, fromVersion: string, toVersion: string): string[] {
  const out: string[] = [];
  let inRelevantSection = false;
  // Whether the current version section uses the old standalone-heading format: there, `-`
  // sub-bullets (some bold-led) nest under each `**Heading**`, so `- **` lines are sub-bullets, not
  // entries, and must not render.
  let sectionUsesStandaloneHeadings = false;

  for (const line of changelog.split('\n')) {
    const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
    if (versionMatch) {
      const currentVersion = versionMatch[1];
      // Bounding the top end matters when upgrading to a specific older
      // version, and guards against a changelog that lists unreleased entries.
      inRelevantSection =
        compareVersions(currentVersion, fromVersion) > 0 &&
        compareVersions(currentVersion, toVersion) <= 0;
      sectionUsesStandaloneHeadings = false;
      if (inRelevantSection) {
        out.push('');
        out.push(chalk.bold(`v${currentVersion}`));
      }
      continue;
    }

    // Only the entry headings, one bullet per feature/fix, across two changelog formats: current `-
    // **Title.** prose` (prose dropped) and older standalone `**Heading**` lines with sub-bullets.
    if (!inRelevantSection) continue;
    if (line.startsWith('**') && line.endsWith('**')) {
      sectionUsesStandaloneHeadings = true;
      out.push(`  ${chalk.cyan('•')} ${line.replace(/\*\*/g, '')}`);
      continue;
    }
    const entryBullet = sectionUsesStandaloneHeadings ? null : line.match(/^- \*\*(.+?)\*\*/);
    if (entryBullet) {
      out.push(`  ${chalk.cyan('•')} ${entryBullet[1].replace(/\*\*/g, '')}`);
    }
  }

  return out;
}
