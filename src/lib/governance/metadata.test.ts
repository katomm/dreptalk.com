import { describe, it, expect } from 'vitest';
import { fetchAnchorMetadata, MAX_ANCHOR_BYTES } from './metadata.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';

const doc = {
  '@context': {},
  hashAlgorithm: 'blake2b-256',
  body: { title: 'Treasury Withdrawal', abstract: 'Fund tooling', rationale: 'We need **tools**.' },
};

// A doc with multi-line rationale containing markdown structure.
const mdDoc = {
  '@context': {},
  hashAlgorithm: 'blake2b-256',
  body: {
    title: 'Governance Proposal',
    abstract: 'First paragraph.\n\nSecond paragraph.',
    rationale: '## Impact\n\nThis is important.\n\n- item a\n- item b',
  },
};
const jsonOf = (o: unknown) => JSON.stringify(o);
// Hash the UTF-8 bytes of the body string; Response(string) yields the same
// bytes via arrayBuffer(), so this matches what fetchAnchorMetadata hashes.
const hashOf = (s: string) => bytesToHex(blake2b256(new TextEncoder().encode(s)));

function resp(body: string, opts: { contentType?: string | null; contentLength?: number; status?: number } = {}) {
  const headers = new Headers();
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'application/json');
  if (opts.contentLength != null) headers.set('content-length', String(opts.contentLength));
  return new Response(body, { status: opts.status ?? 200, headers });
}

describe('fetchAnchorMetadata', () => {
  it('returns ok with parsed, sanitized metadata when the hash matches', async () => {
    const json = jsonOf(doc);
    const res = await fetchAnchorMetadata('https://example.com/m.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    expect(res.metadata?.title).toBe('Treasury Withdrawal');
    expect(res.metadata?.abstract).toBe('Fund tooling');
    expect(res.metadata?.rationaleHtml).toContain('<strong>tools</strong>');
  });

  it('rejects a hash mismatch (does not return metadata)', async () => {
    const json = jsonOf(doc);
    const res = await fetchAnchorMetadata('https://example.com/m.json', 'deadbeef', {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('hash-mismatch');
    expect(res.metadata).toBeNull();
  });

  it('accepts a whitespace-only reserialization mismatch (tool hashed pretty, served minified)', async () => {
    // cgov.io / Mesh hashDrepAnchor hash JSON.stringify(doc, null, 2) but the
    // file served at the URL is minified. Same document, different bytes: the
    // raw-byte hash misses, but re-serializing to the pretty form matches.
    const servedMinified = jsonOf(doc);
    const onchainHash = hashOf(JSON.stringify(doc, null, 2));
    expect(hashOf(servedMinified)).not.toBe(onchainHash); // precondition: bytes differ
    const res = await fetchAnchorMetadata('https://example.com/m.json', onchainHash, {
      fetchImpl: async () => resp(servedMinified),
    });
    expect(res.status).toBe('ok');
    expect(res.metadata?.title).toBe('Treasury Withdrawal');
  });

  it('still rejects a genuine content mismatch (no reserialization matches)', async () => {
    // The served document is not the one that was hashed, in any formatting.
    const res = await fetchAnchorMetadata('https://example.com/m.json', hashOf(jsonOf(mdDoc)), {
      fetchImpl: async () => resp(jsonOf(doc)),
    });
    expect(res.status).toBe('hash-mismatch');
    expect(res.metadata).toBeNull();
  });

  it('rejects unsupported URL schemes without fetching', async () => {
    let called = false;
    const res = await fetchAnchorMetadata('file:///etc/passwd', 'aa', {
      fetchImpl: async () => {
        called = true;
        return resp(jsonOf(doc));
      },
    });
    expect(res.status).toBe('unsupported-url');
    expect(called).toBe(false);
  });

  it('rejects an oversize document by declared content-length', async () => {
    const json = jsonOf(doc);
    const res = await fetchAnchorMetadata('https://example.com/m.json', hashOf(json), {
      fetchImpl: async () => resp(json, { contentLength: MAX_ANCHOR_BYTES + 1 }),
    });
    expect(res.status).toBe('too-large');
  });

  it('accepts a document larger than the old 100KB limit (real proposals reach ~1MB)', async () => {
    // Several mainnet CIP-108 proposals (e.g. "Cardano Vision 2026") have a long
    // rationale that pushes the doc just over 100KB; the title must still extract.
    const bigDoc = {
      '@context': {},
      hashAlgorithm: 'blake2b-256',
      body: { title: 'Large Proposal', abstract: 'A', rationale: 'x'.repeat(150_000) },
    };
    const json = jsonOf(bigDoc);
    expect(json.length).toBeGreaterThan(100_000); // over the previous cap
    expect(json.length).toBeLessThan(MAX_ANCHOR_BYTES); // within the raised cap
    const res = await fetchAnchorMetadata('https://example.com/m.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    expect(res.metadata?.title).toBe('Large Proposal');
  });

  it('rejects a non-JSON/text content type', async () => {
    const json = jsonOf(doc);
    const res = await fetchAnchorMetadata('https://example.com/x', hashOf(json), {
      fetchImpl: async () => resp(json, { contentType: 'text/html' }),
    });
    expect(res.status).toBe('bad-content-type');
  });

  it('reports parse-failed for non-JSON bytes whose hash matches', async () => {
    const body = 'not json {';
    const res = await fetchAnchorMetadata('https://example.com/x', hashOf(body), {
      fetchImpl: async () => resp(body, { contentType: 'text/plain' }),
    });
    expect(res.status).toBe('parse-failed');
  });

  it('maps ipfs:// to a gateway URL', async () => {
    const json = jsonOf(doc);
    let fetched = '';
    const res = await fetchAnchorMetadata('ipfs://QmCidExample/meta.json', hashOf(json), {
      fetchImpl: async (url) => {
        fetched = String(url);
        return resp(json);
      },
    });
    expect(fetched).toBe('https://ipfs.io/ipfs/QmCidExample/meta.json');
    expect(res.status).toBe('ok');
  });

  it('preserves markdown structure in rationale (headings, paragraphs, lists)', async () => {
    const json = jsonOf(mdDoc);
    const res = await fetchAnchorMetadata('https://example.com/md.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    // The rationaleHtml must contain rendered markdown elements, not a raw blob.
    expect(res.metadata?.rationaleHtml).toContain('<h2>');
    expect(res.metadata?.rationaleHtml).toContain('<p>');
    expect(res.metadata?.rationaleHtml).toContain('<ul>');
    expect(res.metadata?.rationaleHtml).toContain('<li>');
    // Must not contain literal unrendered markdown syntax.
    expect(res.metadata?.rationaleHtml).not.toContain('## Impact');
    expect(res.metadata?.rationaleHtml).not.toContain('- item a');
  });

  it('preserves newlines in abstract (multi-paragraph abstract)', async () => {
    const json = jsonOf(mdDoc);
    const res = await fetchAnchorMetadata('https://example.com/md.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    // The stored abstract string must retain the paragraph-separating newline.
    expect(res.metadata?.abstract).toContain('\n');
    expect(res.metadata?.abstract).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('merges motivation and rationale so neither field is dropped', async () => {
    // Proposers routinely split one document across both fields (motivation =
    // intro/early sections, rationale = later sections). Both must survive; the
    // old `rationale || motivation` silently dropped the motivation.
    const splitDoc = {
      '@context': {},
      hashAlgorithm: 'blake2b-256',
      body: {
        title: 'Split Proposal',
        abstract: 'Summary.',
        motivation: '### 1. Introduction\n\nThe problem statement.',
        rationale: '### 2. Solution\n\nThe proposed solution.',
      },
    };
    const json = jsonOf(splitDoc);
    const res = await fetchAnchorMetadata('https://example.com/s.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    const html = res.metadata?.rationaleHtml ?? '';
    expect(html).toContain('1. Introduction');
    expect(html).toContain('The problem statement.');
    expect(html).toContain('2. Solution');
    // Order: motivation first, then rationale.
    expect(html.indexOf('Introduction')).toBeLessThan(html.indexOf('Solution'));
  });

  it('falls back to motivation alone when rationale is absent', async () => {
    const motOnly = {
      '@context': {},
      hashAlgorithm: 'blake2b-256',
      body: { title: 'T', abstract: 'A', motivation: 'Only the **motivation** exists.' },
    };
    const json = jsonOf(motOnly);
    const res = await fetchAnchorMetadata('https://example.com/m.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    expect(res.metadata?.rationaleHtml).toContain('<strong>motivation</strong>');
  });

  it('does not duplicate text when motivation and rationale are identical', async () => {
    const dup = {
      '@context': {},
      hashAlgorithm: 'blake2b-256',
      body: { title: 'T', abstract: 'A', motivation: 'Same body here.', rationale: 'Same body here.' },
    };
    const json = jsonOf(dup);
    const res = await fetchAnchorMetadata('https://example.com/d.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    const html = res.metadata?.rationaleHtml ?? '';
    expect(html.match(/Same body here\./g)?.length).toBe(1);
  });

  it('keeps a long rationale that would have been cut at the old 20k cap', async () => {
    // The old MAX_RATIONALE_LEN of 20k truncated real proposals (e.g. IO: Hydra,
    // ~32k rationale). The raised cap keeps the tail.
    const tail = 'END_MARKER_TEXT';
    const longDoc = {
      '@context': {},
      hashAlgorithm: 'blake2b-256',
      body: { title: 'T', abstract: 'A', rationale: `${'word '.repeat(6_000)}\n\n${tail}` },
    };
    const json = jsonOf(longDoc);
    expect(longDoc.body.rationale.length).toBeGreaterThan(20_000);
    const res = await fetchAnchorMetadata('https://example.com/l.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    expect(res.metadata?.rationaleHtml).toContain(tail);
  });

  it('appends a truncation notice with anchor link when the body exceeds the cap', async () => {
    // A pathological outlier (>100k chars) is capped, but the reader is told and
    // pointed at the on-chain anchor for the full document.
    const hugeDoc = {
      '@context': {},
      hashAlgorithm: 'blake2b-256',
      body: { title: 'T', abstract: 'A', rationale: 'z'.repeat(150_000) },
    };
    const json = jsonOf(hugeDoc);
    const res = await fetchAnchorMetadata('ipfs://QmHugeCid/meta.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.status).toBe('ok');
    const html = res.metadata?.rationaleHtml ?? '';
    expect(html.toLowerCase()).toContain('truncated');
    // Links to the resolved gateway URL of the anchor.
    expect(html).toContain('https://ipfs.io/ipfs/QmHugeCid/meta.json');
  });

  it('extracts author names, compact and @value form, in document order', async () => {
    const json = jsonOf({
      '@context': {},
      hashAlgorithm: 'blake2b-256',
      body: { title: 'T', abstract: 'A', rationale: 'R' },
      authors: [{ name: 'Lantr Engineering' }, { name: { '@value': 'FluidTokens' } }],
    });
    const res = await fetchAnchorMetadata('https://example.com/a.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.metadata?.authors).toEqual(['Lantr Engineering', 'FluidTokens']);
  });

  it('returns null authors for an empty array, a missing field, and nameless entries', async () => {
    const cases = [
      { '@context': {}, body: { title: 'T' }, authors: [] },
      { '@context': {}, body: { title: 'T' } },
      { '@context': {}, body: { title: 'T' }, authors: [{ witness: { signature: 'ab' } }] },
      { '@context': {}, body: { title: 'T' }, authors: 'not-an-array' },
    ];
    for (const c of cases) {
      const json = jsonOf(c);
      const res = await fetchAnchorMetadata('https://example.com/a.json', hashOf(json), {
        fetchImpl: async () => resp(json),
      });
      expect(res.metadata?.authors).toBeNull();
    }
  });

  it('caps name length and author count', async () => {
    const json = jsonOf({
      '@context': {},
      body: { title: 'T' },
      authors: Array.from({ length: 14 }, (_, i) => ({ name: `${'x'.repeat(200)}${i}` })),
    });
    const res = await fetchAnchorMetadata('https://example.com/a.json', hashOf(json), {
      fetchImpl: async () => resp(json),
    });
    expect(res.metadata?.authors).toHaveLength(10);
    for (const n of res.metadata?.authors ?? []) expect(n.length).toBeLessThanOrEqual(80);
  });
});
