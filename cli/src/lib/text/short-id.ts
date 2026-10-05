// Prefix-only IDs fall back to the unstripped value so stored rows remain addressable.
export function deriveShortId(id: string, stripPrefix?: RegExp): string {
  const stripped = stripPrefix ? id.replace(stripPrefix, '') : id;
  return stripped.slice(0, 8) || id.slice(0, 8) || id;
}
