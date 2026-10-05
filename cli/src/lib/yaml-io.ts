import * as yaml from 'yaml';

/** Single serialization for every writer editing a shared committed YAML doc. RUSH-2505: the
 * emitter padded flow collections and five writers disagreed on style, so no-op diffs dirtied
 * trees and `agents repo pull` refused. Block is forced only when the root is flow. */
export function stringifyDoc(doc: yaml.Document, options: yaml.ToStringOptions = {}): string {
  // A flow root makes every edited node render flow; normalize the whole doc to
  // block in that case only. `contents.flow` is undefined for a block root.
  const rootIsFlow = (doc.contents as { flow?: boolean } | null)?.flow === true;
  return doc.toString({
    flowCollectionPadding: false,
    ...(rootIsFlow ? { collectionStyle: 'block' as const } : {}),
    ...options,
  });
}
