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
});
