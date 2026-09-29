// Minimal HTML entity escape for text interpolated into markup. Kept in its own
// module, free of other imports, so browser code can use it without pulling in
// the markdown renderer.
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
