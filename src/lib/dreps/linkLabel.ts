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
