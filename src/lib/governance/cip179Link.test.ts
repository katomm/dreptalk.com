// The CIP-179 survey link lives at body.cip179 and must survive URDNA2015
// canonicalization, or it sits outside the author witness. The CIP-108 context
// sets no @vocab, so an unmapped field is dropped silently: these tests exist
// because anchorContextMapsCip179Terms alone does not prove the link is covered.
import { describe, it, expect } from 'vitest';
import { anchorContextMapsCip179Terms, parseCip179Link, GOV_LINK_KIND } from 'cip-179/domain';
import { canonicalBodyHashFor, contextForBody, type Cip108Body } from './cip108Canonical.js';

const TX = 'a'.repeat(64);
const linked: Cip108Body = {
  title: 'T', abstract: 'A', motivation: 'M', rationale: 'R',
  cip179: { specVersion: 5, kind: 'survey-link', surveyTxId: TX, surveyIndex: 0 },
};
const plain: Cip108Body = { title: 'T', abstract: 'A', motivation: 'M', rationale: 'R' };

describe('the extended context', () => {
  it('is only used when a link is present, so unlinked docs keep their bytes', () => {
    expect(contextForBody(plain)).not.toHaveProperty('CIP179');
    expect(contextForBody(linked)).toHaveProperty('CIP179');
  });

  it('satisfies the CIP-179 authoring check', () => {
    expect(anchorContextMapsCip179Terms({ '@context': contextForBody(linked), body: linked })).toBe(true);
  });

  it('is accepted by the JSON-LD processor, not just by the predicate', async () => {
    await expect(canonicalBodyHashFor(linked)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips the ref through the CIP-179 reader', () => {
    const res = parseCip179Link({ '@context': contextForBody(linked), body: linked });
    expect(res.problems).toEqual([]);
    expect(res.surveyRef).toEqual({ txId: TX, index: 0 });
    expect(linked.cip179?.kind).toBe(GOV_LINK_KIND);
  });
});

describe('every link field is actually covered by the canonical hash', () => {
  it('a linked body hashes differently from the same body without the link', async () => {
    expect(await canonicalBodyHashFor(linked)).not.toBe(await canonicalBodyHashFor(plain));
  });

  // If a sub-term were unmapped, its field would vanish during canonicalization
  // and these would silently produce identical hashes.
  const variants: Array<[string, Cip108Body]> = [
    ['surveyTxId', { ...linked, cip179: { ...linked.cip179!, surveyTxId: 'b'.repeat(64) } }],
    ['surveyIndex', { ...linked, cip179: { ...linked.cip179!, surveyIndex: 7 } }],
    ['specVersion', { ...linked, cip179: { ...linked.cip179!, specVersion: 4 } }],
    ['kind', { ...linked, cip179: { ...linked.cip179!, kind: 'something-else' as 'survey-link' } }],
  ];
  for (const [field, variant] of variants) {
    it(`changing ${field} changes the canonical hash`, async () => {
      expect(await canonicalBodyHashFor(variant)).not.toBe(await canonicalBodyHashFor(linked));
    });
  }
});

describe('the builder carries the link into the served document', () => {
  it('embeds cip179 last, with the extended context, and omits it when absent', async () => {
    const { buildInfoActionMetadata } = await import('./infoActionMetadata.js');
    const withLink = JSON.parse(buildInfoActionMetadata({ body: linked, authors: [] }).body);
    expect(Object.keys(withLink.body).at(-1)).toBe('cip179');
    expect(withLink.body.cip179).toEqual(linked.cip179);
    expect(withLink['@context']).toHaveProperty('CIP179');
    expect(anchorContextMapsCip179Terms(withLink)).toBe(true);
    expect(parseCip179Link(withLink).surveyRef).toEqual({ txId: TX, index: 0 });

    const without = JSON.parse(buildInfoActionMetadata({ body: plain, authors: [] }).body);
    expect(without.body).not.toHaveProperty('cip179');
    expect(without['@context']).not.toHaveProperty('CIP179');
  });
});
