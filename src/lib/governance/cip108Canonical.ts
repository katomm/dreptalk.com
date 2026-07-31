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

export interface Cip108Body {
  title: string;
  abstract: string;
  motivation: string;
  rationale: string;
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
export async function canonicalBodyHashFor(body: Record<string, unknown>): Promise<string> {
  // `body` accepts any plain object (see Cip108Body / the vector's extra `references`
  // key); @types/jsonld's NodeObject shape is far stricter than the actual runtime
  // API (which accepts any JSON-LD-compatible document), so this cast is required.
  const doc = { '@context': CIP108_CONTEXT, body } as unknown as JsonLdDocument;
  const canonical = await canonize(doc, {
    algorithm: 'URDNA2015',
    format: 'application/n-quads',
    documentLoader: noNetworkDocumentLoader,
  });
  return bytesToHex(blake2b256(TEXT_ENCODER.encode(canonical)));
}
