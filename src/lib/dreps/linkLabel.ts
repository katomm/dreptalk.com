// Display text for a DRep profile link: the human label when set, otherwise the
// bare hostname (www. stripped), otherwise the raw uri. Many on-chain docs
// (including ones DRepTalk wrote before labels were editable) carry an empty
// label, which would otherwise render as blank link text.
export function linkDisplayLabel(link: { label: string; uri: string }): string {
  if (link.label.trim().length > 0) return link.label;
  try {
    return new URL(link.uri).host.replace(/^www\./, '');
  } catch {
    return link.uri;
  }
}

/**
 * Collapse repeated profile links to one entry per URI (on-chain metadata often
 * lists the same reference more than once). The first occurrence keeps its
 * position; if it has no label and a later duplicate does, that label is
 * adopted so the best name survives the merge.
 */
export function dedupeLinks(
  links: { label: string; uri: string }[],
): { label: string; uri: string }[] {
  const byUri = new Map<string, { label: string; uri: string }>();
  for (const link of links) {
    const key = link.uri.trim();
    const kept = byUri.get(key);
    if (!kept) {
      byUri.set(key, link);
    } else if (kept.label.trim().length === 0 && link.label.trim().length > 0) {
      byUri.set(key, { ...kept, label: link.label });
    }
  }
  return [...byUri.values()];
}
