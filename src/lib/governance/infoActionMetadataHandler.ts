/// <reference types="@cloudflare/workers-types" />
// Orchestrates the InfoAction metadata submit flow: validate + sanitize the
// CIP-108 body, verify an optional author witness BEFORE any upload,
// canonicalize + build the served doc, dedup against D1, pin the exact bytes
// to IPFS, then store the audit row. Mirrors voteRationaleHandler.ts.

import { z } from 'zod';
import { SPEC_VERSION } from 'cip-179';
import { sanitizeExternalText, sanitizeExternalMultiline } from '../validation/input.js';
import { buildInfoActionMetadata } from './infoActionMetadata.js';
import {
  type Cip108Author,
  INFO_TITLE_MAX,
  INFO_ABSTRACT_MAX,
  INFO_MOTIVATION_MAX,
  INFO_RATIONALE_MAX,
  REFERENCE_LABEL_MAX,
  REFERENCE_URI_MAX,
  REFERENCES_MAX,
} from './infoActionLimits.js';
import { canonicalBodyHashFor, type Cip108Body, type Cip108Reference } from './cip108Canonical.js';
import { parseSurveyRefInput } from './surveyRef.js';
import { verifyWalletAuthorWitness } from './authorWitness.js';
import { pinInfoActionMetadata, type FileUploader } from './pinata.js';
import { getGovActionMetadata, putGovActionMetadata } from '../db/govActionMetadata.js';

const AUTHOR_NAME_MAX = 120;

// referenceHash is spec-optional and we do not collect it (see Cip108Reference).
// The caps live in infoActionLimits.ts so the client island shares them.
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
  // A CIP-179 survey reference the user pasted, either "<txId>:<index>" or a
  // link containing one. Normalised (and rejected) by parseSurveyRefInput.
  surveyRef: z.string().max(2048).optional(),
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
type CleanBodyResult = { ok: true; body: Cip108Body } | { ok: false; error: string };

function cleanBody(b: z.infer<typeof bodySchema>): CleanBodyResult {
  const clean: Cip108Body = {
    title: sanitizeExternalText(b.title, INFO_TITLE_MAX),
    abstract: sanitizeExternalMultiline(b.abstract, INFO_ABSTRACT_MAX),
    motivation: sanitizeExternalMultiline(b.motivation, INFO_MOTIVATION_MAX),
    rationale: sanitizeExternalMultiline(b.rationale, INFO_RATIONALE_MAX),
  };
  if (!clean.title || !clean.abstract || !clean.motivation || !clean.rationale) {
    return { ok: false, error: 'empty field after sanitization' };
  }
  const references = cleanReferences(b.references);
  if (references) clean.references = references;

  // The survey link is built here, from a ref we normalised ourselves, so
  // prepare and finalize always canonicalize the identical link.
  if (b.surveyRef !== undefined && b.surveyRef.trim() !== '') {
    const ref = parseSurveyRefInput(b.surveyRef);
    if (!ref.ok) return { ok: false, error: ref.reason };
    clean.cip179 = {
      specVersion: SPEC_VERSION,
      kind: 'survey-link',
      surveyTxId: ref.txId,
      surveyIndex: ref.index,
    };
  }
  return { ok: true, body: clean };
}

export interface InfoActionMetadataInput {
  body: unknown;
  db: D1Database;
  jwt: string;
  now: number; // milliseconds
  expectedNetworkId: number;
  /**
   * Our Pinata group. Absent is allowed and simply means the uploaded file is
   * never collectable, which is the safe direction to fail on a shared account.
   */
  groupId?: string;
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
    const cleaned = cleanBody(parsed.data);
    if (!cleaned.ok) return { status: 400, json: { error: cleaned.error } };
    const bodyHash = await canonicalBodyHashFor(cleaned.body);
    return { status: 200, json: { bodyHash } };
  } catch (err: unknown) {
    // Canonicalization is the only thing that can throw here, and when it does
    // the cause (a context the JSON-LD processor rejects, say) is invisible
    // without this line: the caller only ever sees a generic 500.
    console.error('[gov-action] prepare: canonical body hash failed', err);
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
    const cleaned = cleanBody(parsed.data);
    if (!cleaned.ok) return { status: 400, json: { error: cleaned.error } };
    const clean = cleaned.body;

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

    // Dedup: reuse an existing CID without re-uploading. Serving a row restarts
    // its grace period, so a resubmitted old draft cannot lose the pin it was
    // just handed. A row already claimed for deletion reads as absent and is
    // re-pinned instead, which yields the same CID anyway.
    const nowSec = Math.floor(input.now / 1000);
    const existing = await getGovActionMetadata(input.db, hash, nowSec);
    if (existing) {
      return { status: 200, json: { anchorUrl: `ipfs://${existing.cid}`, anchorHash: hash } };
    }

    const { cid, fileId } = await pinInfoActionMetadata({
      body,
      anchorHash: hash,
      jwt: input.jwt,
      groupId: input.groupId,
      upload: input.upload,
    });
    await putGovActionMetadata(input.db, {
      hash,
      cid,
      body,
      createdAt: nowSec,
      pinataFileId: fileId,
    });
    return { status: 200, json: { anchorUrl: `ipfs://${cid}`, anchorHash: hash } };
  } catch (err: unknown) {
    // Several unrelated things can fail here (canonicalization, the Pinata
    // upload, the D1 write), and the user is told none of them on purpose.
    // Without this line nobody could tell afterwards which one it was.
    console.error('[gov-action] finalize: hosting the metadata failed', err);
    return { status: 500, json: { error: 'internal error' } };
  }
}
