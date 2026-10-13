import { levenshtein } from '../fuzzy.js';

export function closestTopLevelCommand(
  unknown: string,
  candidates: Iterable<string>,
): { closest: string | null; minDist: number } {
  let closest: string | null = null;
  let minDist = Infinity;
  for (const cmd of candidates) {
    const dist = levenshtein(unknown, cmd);
    if (dist < minDist) {
      minDist = dist;
      closest = cmd;
    }
  }
  return { closest, minDist };
}
