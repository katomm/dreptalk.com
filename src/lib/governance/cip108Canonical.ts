// URDNA2015 canonicalization of a CIP-108 `body`, per the official CIP-108 method:
// canonicalize a document containing ONLY { '@context', body } and hash all n-quads.
// The witness signs blake2b-256 of these canonical bytes (NOT the anchor hash).
import jsonld from 'jsonld';
import type { JsonLdDocument, Options } from 'jsonld';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';

// The @types/jsonld community typings model `canonize` as an overloaded
// callback-or-promise function, and TypeScript resolves the mixed overload
// set ambiguously when called with a plain options object, inferring a
// nonsensical `void & Promise<string>` return type. Pinning the exact
// Promise-returning overload here (the only one this module calls) resolves
// the call cleanly instead of casting at every call site.
const canonize = jsonld.canonize as (
  input: JsonLdDocument,
  options: Options.Normalize,
) => Promise<string>;

// A GovTool-style reference link. `referenceHash` (an optional
// {hashAlgorithm, hashDigest} proving the linked document's content) is part
// of the CIP-108 spec but we do not collect it, so it is omitted here.
export interface Cip108Reference {
  '@type': 'Other';
  label: string;
  uri: string;
}

/**
 * The CIP-179 survey link a Conway Info Action carries to point at a survey.
 * Lives at `body.cip179`, so it is inside what the author witness signs.
 */
export interface Cip179SurveyLink {
  specVersion: number;
  kind: 'survey-link';
  surveyTxId: string;
  surveyIndex: number;
}

export interface Cip108Body {
  title: string;
  abstract: string;
  motivation: string;
  rationale: string;
  references?: Cip108Reference[];
  cip179?: Cip179SurveyLink;
}

// Verbatim @context from the official CIP-108 example
// (src/lib/governance/__fixtures__/cip108-no-confidence.jsonld). Do not hand-edit;
// the interop test asserts this equals the fixture's @context byte-for-byte.
export const CIP108_CONTEXT = {
  '@language': 'en-us',
  CIP100: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#',
  CIP108: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0108/README.md#',
  hashAlgorithm: 'CIP100:hashAlgorithm',
  body: {
    '@id': 'CIP108:body',
    '@context': {
      references: {
        '@id': 'CIP108:references',
        '@container': '@set',
        '@context': {
          GovernanceMetadata: 'CIP100:GovernanceMetadataReference',
          Other: 'CIP100:OtherReference',
          label: 'CIP100:reference-label',
          uri: 'CIP100:reference-uri',
          referenceHash: {
            '@id': 'CIP108:referenceHash',
            '@context': {
              hashDigest: 'CIP108:hashDigest',
              hashAlgorithm: 'CIP100:hashAlgorithm',
            },
          },
        },
      },
      title: 'CIP108:title',
      abstract: 'CIP108:abstract',
      motivation: 'CIP108:motivation',
      rationale: 'CIP108:rationale',
    },
  },
  authors: {
    '@id': 'CIP100:authors',
    '@container': '@set',
    '@context': {
      name: 'http://xmlns.com/foaf/0.1/name',
      witness: {
        '@id': 'CIP100:witness',
        '@context': {
          witnessAlgorithm: 'CIP100:witnessAlgorithm',
          publicKey: 'CIP100:publicKey',
          signature: 'CIP100:signature',
        },
      },
    },
  },
} as const;

// CIP-179 linkage Change 3: a `body.cip179` link MUST be mapped by the
// document's own @context. The CIP-108 context sets no @vocab, so an unmapped
// field is not merely cosmetic, it is dropped from the canonical form (jsonld
// safe mode raises it outright) and would sit outside the author witness, which
// the spec forbids. `anchorContextMapsCip179Terms` from the cip-179 package
// checks the shape but neither the `@id` nor whether the IRIs are usable, so it
// is necessary and not sufficient: cip179Link.test.ts proves each of the four
// sub-fields actually moves the canonical hash.
const CIP179_NS = 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0179/README.md#';

export const CIP108_CONTEXT_WITH_CIP179 = {
  ...CIP108_CONTEXT,
  CIP179: CIP179_NS,
  body: {
    ...CIP108_CONTEXT.body,
    '@context': {
      ...CIP108_CONTEXT.body['@context'],
      cip179: {
        '@id': 'CIP179:link',
        '@context': {
          specVersion: 'CIP179:specVersion',
          kind: 'CIP179:kind',
          surveyTxId: 'CIP179:surveyTxId',
          surveyIndex: 'CIP179:surveyIndex',
        },
      },
    },
  },
} as const;

/**
 * The context a body must be canonicalized and served with. One predicate, so
 * the witness, the canonical hash and the pinned bytes can never disagree about
 * which context a document uses.
 */
export function contextForBody(body: Cip108Body): typeof CIP108_CONTEXT | typeof CIP108_CONTEXT_WITH_CIP179 {
  return body.cip179 ? CIP108_CONTEXT_WITH_CIP179 : CIP108_CONTEXT;
}

const TEXT_ENCODER = new TextEncoder();

// jsonld.canonize resolves any remote `@context` URL it encounters. Our context is
// fully inlined (no remote refs), so no context should ever need to be fetched, but
// pin a document loader that throws instead of hitting the network: workerd has no
// unconditional outbound fetch for arbitrary hosts, and this fails fast instead of
// hanging if a doc ever references one.
function noNetworkDocumentLoader(url: string): never {
  throw new Error(`canonicalBodyHashFor: refusing to fetch remote context "${url}"`);
}

/** blake2b-256 hex of the URDNA2015-canonicalized { '@context', body }. */
export async function canonicalBodyHashFor(body: Cip108Body): Promise<string> {
  // Typed as Cip108Body for callers, but canonize() processes whatever object
  // is passed at runtime; the interop test still passes a vector body with an
  // extra `references` key (typed `any`), which is unaffected by this typing.
  // @types/jsonld's NodeObject shape is far stricter than the actual runtime
  // API (which accepts any JSON-LD-compatible document), so this cast is required.
  const doc = { '@context': contextForBody(body), body } as unknown as JsonLdDocument;
  const canonical = await canonize(doc, {
    algorithm: 'URDNA2015',
    format: 'application/n-quads',
    documentLoader: noNetworkDocumentLoader,
  });
  return bytesToHex(blake2b256(TEXT_ENCODER.encode(canonical)));
}
