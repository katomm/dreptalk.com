// The CIP-100 context is inlined into every emitted document so a plain CIP-100
// parser works with no network fetch and no knowledge of DRepTalk. Our own
// terms live in a versioned file served from the site, referenced as the second
// entry of the @context array.

export const CIP100_INLINE_CONTEXT = {
  '@language': 'en-us',
  CIP100: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#',
  hashAlgorithm: 'CIP100:hashAlgorithm',
  body: {
    '@id': 'CIP100:body',
    '@context': {
      references: {
        '@id': 'CIP100:references',
        '@container': '@set',
        '@context': {
          GovernanceMetadata: 'CIP100:GovernanceMetadataReference',
          Other: 'CIP100:OtherReference',
          label: 'CIP100:reference-label',
          uri: 'CIP100:reference-uri',
        },
      },
      comment: 'CIP100:comment',
      externalUpdates: {
        '@id': 'CIP100:externalUpdates',
        '@context': { title: 'CIP100:update-title', uri: 'CIP100:update-uri' },
      },
    },
  },
  authors: {
    '@id': 'CIP100:authors',
    '@container': '@set',
    '@context': {
      did: '@id',
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

/** Path of the versioned extension context. A new term means a v2 file, so
 *  documents already emitted keep the meaning they were built with. */
export const EXTENSION_CONTEXT_PATH = '/cip100/context/v1.jsonld';

/** The one canonical URL of the extension context, on the mainnet domain for
 *  every network.
 *
 *  This is the deliberate exception to "every absolute URL comes from
 *  originForNetwork". Content URLs identify a document on one network and must
 *  never point at the other. A vocabulary is not content: it has one global
 *  identity, its `dt` IRIs already resolve to dreptalk.com, and the file is
 *  byte-identical on both networks. Pointing preprod documents at
 *  preprod.dreptalk.com would make immutable bytes depend on a test deployment
 *  that may be reset or retired, and their terms would stop resolving the day
 *  it goes away. */
export const EXTENSION_CONTEXT_URL = `https://dreptalk.com${EXTENSION_CONTEXT_PATH}`;
