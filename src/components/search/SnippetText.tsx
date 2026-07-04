import { parseSnippet, cleanMarkdownSnippet } from '@/lib/search/snippet.js';

/** Renders a snippet string (char(1)/char(2) delimited) with matched terms
 *  highlighted. Shared by the search palette and the /search results page so
 *  the highlight markup is defined once. Returns null when nothing matched. */
export function SnippetText({ raw }: { raw: string }) {
  const segments = parseSnippet(cleanMarkdownSnippet(raw));
  if (!segments.some((s) => s.match)) return null;
  // Keys derive from each segment's character offset in the snippet:
  // content-stable and unique, unlike the array index.
  let offset = 0;
  const keyed = segments.map((s) => {
    const key = offset;
    offset += s.text.length;
    return { ...s, key };
  });
  return (
    <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {keyed.map((s) =>
        s.match ? (
          <mark key={s.key} style={{ background: 'transparent', color: 'var(--accent)', fontWeight: 600 }}>
            {s.text}
          </mark>
        ) : (
          <span key={s.key}>{s.text}</span>
        ),
      )}
    </span>
  );
}
