// Guides end their prose with a "## Related" link list. The guide route
// splits the rendered markdown in front of that heading so the frontmatter
// FAQ section can sit between the guide text and its related links.

const RELATED_HEADING = '<h2 id="related">';

export function splitAtRelated(html: string): { body: string; related: string } {
  const at = html.lastIndexOf(RELATED_HEADING);
  if (at === -1) return { body: html, related: '' };
  return { body: html.slice(0, at), related: html.slice(at) };
}
