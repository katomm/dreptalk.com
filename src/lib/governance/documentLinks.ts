// Display helpers for the {label, uri} pairs carried by an on-chain governance
// metadata document. Both surfaces that read such a list use these: CIP-119 DRep
// profiles (body.references on a DRep registration) and CIP-108 governance
// actions (body.references on a proposal anchor). Nothing here is DRep-specific.

/** One reference link read out of an on-chain metadata document. */
export interface DocumentLink {
  /** May be empty: many documents carry a bare URI with no human label. */
  label: string;
  /** Raw on-chain URI, http(s) or ipfs:, resolved to a gateway at display time. */
  uri: string;
}

// Display text for a profile link: the human label when set, otherwise the
// bare hostname (www. stripped), otherwise the raw uri. Many on-chain docs
// (including ones DRepTalk wrote before labels were editable) carry an empty
// label, which would otherwise render as blank link text.
export function linkDisplayLabel(link: DocumentLink): string {
  if (link.label.trim().length > 0) return link.label;
  try {
    return new URL(link.uri).host.replace(/^www\./, '');
  } catch {
    return link.uri;
  }
}

/**
 * Collapse repeated links to one entry per URI (on-chain metadata often lists
 * the same reference more than once). The first occurrence keeps its position;
 * if it has no label and a later duplicate does, that label is adopted so the
 * best name survives the merge.
 */
export function dedupeLinks(links: DocumentLink[]): DocumentLink[] {
  const byUri = new Map<string, DocumentLink>();
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
