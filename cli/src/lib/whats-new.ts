import chalk from 'chalk';
import { compareVersions } from './agent-spec/primitives.js';

export function renderWhatsNew(changelog: string, fromVersion: string, toVersion: string): string[] {
  const out: string[] = [];
  let inRelevantSection = false;
  let sectionUsesStandaloneHeadings = false;

  for (const line of changelog.split('\n')) {
    const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
    if (versionMatch) {
      const currentVersion = versionMatch[1];
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
