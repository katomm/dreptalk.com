/// <reference types="@cloudflare/workers-types" />
// Orchestrates the InfoAction metadata submit flow: validate + sanitize the
// CIP-108 body, verify an optional author witness BEFORE any upload,
// canonicalize + build the served doc, dedup against D1, pin the exact bytes
// to IPFS, then store the audit row. Mirrors voteRationaleHandler.ts.

import { z } from 'zod';
import { sanitizeExternalText, sanitizeExternalMultiline } from '../validation/input.js';
import { buildInfoActionMetadata } from './infoActionMetadata.js';
import {
  type Cip108Author,
  INFO_TITLE_MAX,
  INFO_ABSTRACT_MAX,
  INFO_MOTIVATION_MAX,
  INFO_RATIONALE_MAX,
} from './infoActionLimits.js';
import { canonicalBodyHashFor, type Cip108Body, type Cip108Reference } from './cip108Canonical.js';
import { verifyWalletAuthorWitness } from './authorWitness.js';
import { pinInfoActionMetadata, type FileUploader } from './pinata.js';
import { getGovActionMetadata, putGovActionMetadata } from '../db/govActionMetadata.js';

const AUTHOR_NAME_MAX = 120;

// Mirrors GovTool's reference-link caps. referenceHash is spec-optional and
// we do not collect it (see Cip108Reference).
const REFERENCE_LABEL_MAX = 200;
const REFERENCE_URI_MAX = 2048;
const REFERENCES_MAX = 10;

const referenceSchema = z.object({
  label: z.string().min(1).max(REFERENCE_LABEL_MAX),
  uri: z.string().url().max(REFERENCE_URI_MAX),
});

const bodySchema = z.object({
  title: z.string().min(1).max(INFO_TITLE_MAX),
  abstract: z.string().min(1).max(INFO_ABSTRACT_MAX),
  motivation: z.string().min(1).max(INFO_MOTIVATION_MAX),
  rationale: z.string().min(1).max(INFO_RATIONALE_MAX),
  references: z.array(referenceSchema).max(REFERENCES_MAX).optional(),
  author: z
    .object({
      name: z.string().min(1).max(AUTHOR_NAME_MAX),
      keyHex: z.string().max(4096).regex(/^[0-9a-fA-F]+$/),
      signatureHex: z.string().max(4096).regex(/^[0-9a-fA-F]+$/),
    })
    .optional(),
});

// Sanitizes each candidate reference and drops entries left empty by
// sanitization (e.g. a label that was only control characters). Returns
// undefined rather than [] so the caller can omit the key entirely, matching
// buildInfoActionMetadata's omit-when-empty behavior.
function cleanReferences(refs: z.infer<typeof referenceSchema>[] | undefined): Cip108Reference[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  const cleaned: Cip108Reference[] = [];
  for (const r of refs) {
    const label = sanitizeExternalText(r.label, REFERENCE_LABEL_MAX);
    const uri = sanitizeExternalText(r.uri, REFERENCE_URI_MAX);
    if (!label || !uri) continue;
    cleaned.push({ '@type': 'Other', label, uri });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

// Sanitize every field, then re-check non-emptiness: sanitize can strip a
// field to '' (e.g. an input that was only control characters).
function cleanBody(b: z.infer<typeof bodySchema>): Cip108Body | null {
  const clean: Cip108Body = {
    title: sanitizeExternalText(b.title, INFO_TITLE_MAX),
    abstract: sanitizeExternalMultiline(b.abstract, INFO_ABSTRACT_MAX),
    motivation: sanitizeExternalMultiline(b.motivation, INFO_MOTIVATION_MAX),
    rationale: sanitizeExternalMultiline(b.rationale, INFO_RATIONALE_MAX),
  };
  if (!clean.title || !clean.abstract || !clean.motivation || !clean.rationale) return null;
  const references = cleanReferences(b.references);
  if (references) clean.references = references;
  return clean;
}

export interface InfoActionMetadataInput {
  body: unknown;
  db: D1Database;
  jwt: string;
  now: number; // milliseconds
  expectedNetworkId: number;
  upload?: FileUploader;
}

export interface InfoActionMetadataResult {
  status: number;
  json: unknown;
}

/**
 * Computes the canonical body hash the client must sign as an author
 * witness, for the `prepare` step of the submit flow. Never throws;
 * unexpected errors become a generic 500.
 */
export async function prepareInfoActionBodyHash(body: unknown): Promise<InfoActionMetadataResult> {
  try {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, json: { error: parsed.error.issues[0]?.message ?? 'invalid input' } };
    }
    const clean = cleanBody(parsed.data);
    if (!clean) return { status: 400, json: { error: 'empty field after sanitization' } };
    const bodyHash = await canonicalBodyHashFor(clean);
    return { status: 200, json: { bodyHash } };
  } catch {
    return { status: 500, json: { error: 'internal error' } };
  }
}

/**
 * Validates, verifies the optional author witness, canonicalizes, pins to
 * IPFS, and stores a dedup/audit row. Never throws; unexpected errors become
 * a generic 500.
 *
 * Error-contract ordering: validate/sanitize -> verify witness (if an author
 * is present) -> D1 lookup by anchor hash (reuse an existing CID without
 * re-uploading) -> pin the exact bytes to Pinata -> insert the audit row only
 * after a successful CID. An anchor is never returned before Pinata confirms
 * a CID (or D1 already has one on record).
 *
 * Recomputes the canonical body hash from the submitted (sanitized) body
 * here rather than trusting a client-sent hash from `prepare`: the witness
 * must be verified against what this call actually anchors, not against
 * whatever hash the client claims it signed. No cross-request hash cache.
 */
export async function handleInfoActionMetadata(
  input: InfoActionMetadataInput,
): Promise<InfoActionMetadataResult> {
  try {
    const parsed = bodySchema.safeParse(input.body);
    if (!parsed.success) {
      return { status: 400, json: { error: parsed.error.issues[0]?.message ?? 'invalid input' } };
    }
    const clean = cleanBody(parsed.data);
    if (!clean) return { status: 400, json: { error: 'empty field after sanitization' } };

    // Authors: [] unless a valid wallet witness is supplied. The witness is
    // verified against the canonical hash of the SAME sanitized body that is
    // embedded in the served/anchored doc below, before any upload happens.
    const authors: Cip108Author[] = [];
    if (parsed.data.author) {
      const name = sanitizeExternalText(parsed.data.author.name, AUTHOR_NAME_MAX);
      if (!name) return { status: 400, json: { error: 'empty author name' } };
      const bodyHash = await canonicalBodyHashFor(clean);
      const verified = await verifyWalletAuthorWitness({
        keyHex: parsed.data.author.keyHex,
        signatureHex: parsed.data.author.signatureHex,
        bodyHashHex: bodyHash,
        expectedNetworkId: input.expectedNetworkId,
      });
      if (!verified.ok) return { status: 400, json: { error: 'invalid author witness' } };
      authors.push({
        name,
        witness: {
          witnessAlgorithm: 'CIP-0008',
          publicKey: verified.publicKeyHex,
          signature: parsed.data.author.signatureHex,
        },
      });
    }

    const { body, hash } = buildInfoActionMetadata({ body: clean, authors });

    // Dedup: reuse an existing CID without re-uploading.
    const existing = await getGovActionMetadata(input.db, hash);
    if (existing) {
      return { status: 200, json: { anchorUrl: `ipfs://${existing.cid}`, anchorHash: hash } };
    }

    const { cid } = await pinInfoActionMetadata({ body, anchorHash: hash, jwt: input.jwt, upload: input.upload });
    await putGovActionMetadata(input.db, { hash, cid, body, createdAt: Math.floor(input.now / 1000) });
    return { status: 200, json: { anchorUrl: `ipfs://${cid}`, anchorHash: hash } };
  } catch {
    return { status: 500, json: { error: 'internal error' } };
  }
}
