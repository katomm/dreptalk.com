/// <reference types="@cloudflare/workers-types" />
// Hosted DRep group profile documents: CIP-100 JSON-LD stored by content hash so a group's
// on-chain anchor can point at an immutable URL, plus the cleanup of documents no chain
// transaction ever referenced.
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { hashBytes } from './codec.js';
import { GROUP_JSONLD_CONTEXT, PROFILE_DOC_GRACE_MS } from './constants.js';

export interface GroupProfileInput {
  name: string;
  description?: string;
  website?: string;
  image?: string;
  charter?: string;
}

/** Documents deleted per run. */
export const GC_MAX_DELETES = 200;
/** Candidate rows read per page and in all, so a long tail of kept documents never turns one run into a scan. */
const GC_PAGE = 200;
const GC_MAX_SCANNED = 2000;

const TEXT_ENCODER = new TextEncoder();

// The context object of the group library, embedded inline as its README recommends. The
// GitHub URL is only the term namespace.
const GROUP_CONTEXT = {
  '@language': 'en-us',
  CIP100: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#',
  DRG: `${GROUP_JSONLD_CONTEXT}#`,
  hashAlgorithm: 'CIP100:hashAlgorithm',
  body: {
    '@id': 'DRG:body',
    '@context': {
      name: 'DRG:name',
      description: 'DRG:description',
      website: 'DRG:website',
      image: 'DRG:image',
      charter: 'DRG:charter',
      paymentAddresses: {
        '@id': 'DRG:paymentAddresses',
        '@container': '@set',
        '@context': {
          address: 'DRG:address',
          purpose: 'DRG:purpose',
          paymentScript: 'DRG:paymentScript',
        },
      },
    },
  },
};

/** The profile document, serialized once, and the blake2b-256 of exactly those bytes as lowercase hex. */
export function buildProfileDoc(p: GroupProfileInput): { body: string; hash: string } {
  const fields: Record<string, string> = { name: p.name };
  if (p.description) fields.description = p.description;
  if (p.website) fields.website = p.website;
  if (p.image) fields.image = p.image;
  if (p.charter) fields.charter = p.charter;
  const body = JSON.stringify({ '@context': GROUP_CONTEXT, hashAlgorithm: 'blake2b-256', body: fields });
  return { body, hash: bytesToHex(blake2b256(TEXT_ENCODER.encode(body))) };
}

/** Stores a document. Storing the same bytes again only refreshes the age and never clears the anchored mark. */
export async function putProfileDoc(
  db: D1Database,
  doc: { hash: string; body: string; createdBy: string; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drep_group_profile_docs (hash, body, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET created_at = excluded.created_at`,
    )
    .bind(doc.hash, doc.body, doc.createdBy, doc.now)
    .run();
}

export async function getProfileDocBody(db: D1Database, hash: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT body FROM drep_group_profile_docs WHERE hash = ?')
    .bind(hash)
    .first<{ body: string }>();
  return row?.body ?? null;
}

// Unanchored documents older than the grace, oldest first, that no pending multisig row still
// needs: every row naming the hash must be failed or never included and resolved before the cutoff.
const CANDIDATES_SQL = `
  SELECT d.hash, d.created_at FROM drep_group_profile_docs d
  WHERE d.anchored = 0 AND d.created_at < ?1 AND (d.created_at, d.hash) > (?2, ?3)
    AND NOT EXISTS (
      SELECT 1 FROM pending_multisig_tx p
      WHERE p.profile_hash = d.hash
        AND (p.resolution IS NULL OR p.resolution NOT IN ('failed', 'never_included')
             OR COALESCE(p.resolved_at, p.never_included_at) IS NULL
             OR COALESCE(p.resolved_at, p.never_included_at) >= ?1)
    )
  ORDER BY d.created_at, d.hash
  LIMIT ?4`;

/**
 * Deletes hosted documents that no chain transaction or pending signature collection can still
 * need, at most GC_MAX_DELETES per run. A document stays while its hash is in the anchor
 * references of a stored label transaction (processed or not), which also covers every applied
 * version.
 */
export async function gcProfileDocs(db: D1Database, now: number): Promise<{ deleted: number }> {
  const cutoff = now - PROFILE_DOC_GRACE_MS;
  let deleted = 0;
  let scanned = 0;
  let afterAt = -1;
  let afterHash = '';
  while (deleted < GC_MAX_DELETES && scanned < GC_MAX_SCANNED) {
    const { results } = await db
      .prepare(CANDIDATES_SQL)
      .bind(cutoff, afterAt, afterHash, GC_PAGE)
      .all<{ hash: string; created_at: number }>();
    if (results.length === 0) break;
    scanned += results.length;
    const last = results[results.length - 1];
    afterAt = last.created_at;
    afterHash = last.hash;

    const refd = new Set<string>();
    const refRows = await db.batch(
      results.map((r) => db.prepare('SELECT 1 AS x FROM drep_group_anchor_refs WHERE hash = ? LIMIT 1').bind(hashBytes(r.hash))),
    );
    refRows.forEach((res, i) => {
      if (res.results.length > 0) refd.add(results[i].hash);
    });
    const doomed = results.filter((r) => !refd.has(r.hash)).slice(0, GC_MAX_DELETES - deleted);
    if (doomed.length > 0) {
      await db.batch(
        doomed.map((r) => db.prepare('DELETE FROM drep_group_profile_docs WHERE hash = ? AND anchored = 0 AND created_at < ?').bind(r.hash, cutoff)),
      );
      deleted += doomed.length;
    }
    if (results.length < GC_PAGE) break;
  }
  return { deleted };
}
