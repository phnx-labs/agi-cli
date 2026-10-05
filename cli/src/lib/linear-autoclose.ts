
export interface PrInfo {
  state: string;
  mergedAt: string | null;
}

export function shouldCloseIssue(pr: PrInfo): boolean {
  return pr.state === 'MERGED' && pr.mergedAt !== null;
}
