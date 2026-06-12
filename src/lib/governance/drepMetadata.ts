// CIP-119 DRep metadata builder.
//
// Builds the canonical JSON-LD document body (stable key order, UTF-8) and
// computes its blake2b-256 hash. The hash is what gets embedded as the on-chain
// anchor hash; the body is what gets served at the anchor URL.
//
// CIP-119 spec: https://github.com/cardano-foundation/CIPs/blob/master/CIP-0119/README.md
// Example document used to confirm field names: CIP-0119/examples/drep.jsonld

import { blake2b256 } from '@/lib/crypto/blake.js';
import { bytesToHex } from '@/lib/crypto/hex.js';
import { sanitizeExternalText } from '@/lib/validation/input.js';

// Reused across every buildDrepMetadata call; allocation is cheap but
// TextEncoder has no state, so a single module-level instance is fine.
const TEXT_ENCODER = new TextEncoder();

// Character limits defined by CIP-119 and enforced before hashing.
export const MAX_DREP_NAME = 80;
export const MAX_DREP_BIO = 1000;
export const MAX_DREP_LINKS = 6;

// Per-link URL length cap. CIP-119 is silent on URL length; 2048 matches
// common browser and HTTP server limits.
const MAX_LINK_URL_LEN = 2048;

export interface DrepImageInput {
  url: string;
  /** sha256 (64 lowercase hex) of the image bytes; optional for foreign hosts. */
  sha256?: string;
}

export interface DrepMetadataInput {
  name: string;
  bio: string;
  links: string[];
  image?: DrepImageInput;
}

export interface DrepMetadataResult {
  // Sanitized, length-capped values stored in the document.
  name: string;
  bio: string;
  links: string[];
  // Canonical CIP-119 JSON string (stable key order, UTF-8).
  body: string;
  // blake2b-256 hash of the UTF-8 bytes of `body`, as 64 lowercase hex chars.
  hash: string;
}

/** Returns true when the URL uses https and parses without error. */
function isValidHttpsUrl(raw: string): boolean {
  if (raw.length > MAX_LINK_URL_LEN) return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns true when the URL uses http or https and parses without error. */
function isValidHttpUrl(raw: string): boolean {
  if (raw.length > MAX_LINK_URL_LEN) return false;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Builds a minimal CIP-119 compliant metadata document and hashes it.
 *
 * The JSON body uses a fixed key order so that the same logical inputs always
 * produce identical bytes, and therefore an identical blake2b-256 hash. This
 * is required because the hash is embedded on-chain as the anchor hash: any
 * serialization variance would make the document unverifiable.
 */
export function buildDrepMetadata(input: DrepMetadataInput): DrepMetadataResult {
  const name = sanitizeExternalText(input.name, MAX_DREP_NAME);
  const bio = sanitizeExternalText(input.bio, MAX_DREP_BIO);

  const links = input.links
    .filter(isValidHttpUrl)
    .slice(0, MAX_DREP_LINKS);

  // Image: only an https URL is embeddable (the sync-side parser drops anything
  // else, and data: URIs would bloat the doc). sha256 rides along when known.
  let image: { '@type': 'ImageObject'; contentUrl: string; sha256?: string } | undefined;
  if (input.image && isValidHttpsUrl(input.image.url)) {
    image = { '@type': 'ImageObject', contentUrl: input.image.url };
    if (input.image.sha256 && /^[0-9a-f]{64}$/.test(input.image.sha256)) {
      image.sha256 = input.image.sha256;
    }
  }

  // Build the JSON-LD document with a fixed key order. Each object literal
  // uses the exact property insertion order that JSON.stringify will preserve,
  // so the serialized form is deterministic regardless of engine version.
  //
  // @context mirrors the CIP-119 example document exactly (CIP-0119/examples/drep.jsonld).
  // Only fields that have values are included; empty/optional fields (image
  // when absent, paymentAddress, qualifications, motivations, doNotList) are
  // omitted so that the document remains minimal and the hash is stable.
  const doc = {
    '@context': {
      CIP100: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#',
      CIP119: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0119/README.md#',
      hashAlgorithm: 'CIP100:hashAlgorithm',
      body: {
        '@id': 'CIP119:body',
        '@context': {
          references: {
            '@id': 'CIP119:references',
            '@container': '@set',
            '@context': {
              GovernanceMetadata: 'CIP100:GovernanceMetadataReference',
              Other: 'CIP100:OtherReference',
              label: 'CIP100:reference-label',
              uri: 'CIP100:reference-uri',
            },
          },
          paymentAddress: 'CIP119:paymentAddress',
          givenName: 'CIP119:givenName',
          image: {
            '@id': 'CIP119:image',
            '@context': {
              ImageObject: 'https://schema.org/ImageObject',
            },
          },
          objectives: 'CIP119:objectives',
          motivations: 'CIP119:motivations',
          qualifications: 'CIP119:qualifications',
        },
      },
    },
    hashAlgorithm: 'blake2b-256',
    body: {
      givenName: name,
      ...(image ? { image } : {}),
      objectives: bio,
      references: links.map(uri => ({
        '@type': 'Link' as const,
        label: '',
        uri,
      })),
    },
  };

  const body = JSON.stringify(doc);
  const hash = bytesToHex(blake2b256(TEXT_ENCODER.encode(body)));

  return { name, bio, links, body, hash };
}
