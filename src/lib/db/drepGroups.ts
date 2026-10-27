/// <reference types="@cloudflare/workers-types" />
// DRep group profiles and website checks: the due queue selections and the writes that move
// its rows. A group id is the bech32 id of the page, decoded to the key of the stored group.
import { WEBSITE_RECHECK_MS, PROFILE_RETRY_MS } from '../groups/constants.js';
import { hashBytes, hashFromCol, refBinds, refFromCols } from '../groups/codec.js';
import { groupIdParam, groupIdString } from '../groups/ids.js';
import { Q } from '../groups/store/queries.js';
import { guardedBatch, writeBatch } from '../groups/store/lease.js';

export interface PaymentAddress {
  address: string;
  purpose?: string;
  treasuryScript?: string;
}

export interface ProfileRow {
  groupId: string;
  profileUrl: string | null;
  /** Hash of the anchor document, lowercase hex. */
  dataHash: string | null;
  status: string;
  name: string | null;
  description: string | null;
  website: string | null;
  image: string | null;
  charter: string | null;
  paymentAddresses: PaymentAddress[];
  fetchedAt: number | null;
  websiteVerifiedAt: number | null;
  websiteCheckedAt: number | null;
}

type Row = Record<string, unknown>;

function groupKey(groupId: string): [Uint8Array, number] {
  const ref = groupIdParam(groupId);
  if (!ref) throw new Error(`not a group id: ${groupId}`);
  return refBinds(ref);
}

/**
 * One page of a due queue. With a lease the stale rows of the page are deleted in the same batch,
 * so rows of unlisted or anchorless groups never pile up in front of the work.
 */
async function duePage(db: D1Database, page: string, dropStale: string, now: number, limit: number, lease?: string): Promise<Row[]> {
  const read = db.prepare(page).bind(now, limit);
  if (lease === undefined) return (await read.all<Row>()).results ?? [];
  const res = await guardedBatch(db, lease, [read, db.prepare(dropStale).bind(now, limit)]);
  return (res[1].results as Row[] | undefined) ?? [];
}

/** Listed groups with an anchor whose profile is due, oldest due first. Pass the lease to clear stale due rows. */
export async function profilesToFetch(
  db: D1Database,
  now: number,
  limit: number,
  lease?: string,
): Promise<Array<{ groupId: string; url: string; dataHash: string }>> {
  const rows = await duePage(db, Q.profileDuePage.sql, Q.profileDueDropStale.sql, now, limit, lease);
  return rows
    .filter((r) => !r.stale)
    .map((r) => ({
      groupId: groupIdString(refFromCols(r.group_tx, r.group_ix)),
      url: String(r.profile_url),
      dataHash: hashFromCol(r.profile_hash),
    }));
}

/**
 * Stores a fetched profile and moves the due rows. A success ends the profile due row and makes the
 * website due when the profile names one, a failure delays the profile by PROFILE_RETRY_MS. The due
 * rows only move while the group still carries the anchor the profile was fetched for.
 */
export async function upsertProfile(db: D1Database, lease: string, p: ProfileRow, now: number): Promise<void> {
  const [tx, ix] = groupKey(p.groupId);
  const url = p.profileUrl;
  const hash = p.dataHash === null ? null : hashBytes(p.dataHash);
  const stmts = [
    db.prepare(Q.upsertProfile.sql).bind(
      tx,
      ix,
      url,
      hash,
      p.status,
      p.name,
      p.description,
      p.website,
      p.image,
      p.charter,
      p.paymentAddresses.length > 0 ? JSON.stringify(p.paymentAddresses) : null,
      p.fetchedAt,
      p.websiteVerifiedAt,
      p.websiteCheckedAt,
    ),
  ];
  if (url !== null && hash !== null) {
    if (p.status === 'ok') {
      stmts.push(db.prepare(Q.profileDueDone.sql).bind(tx, ix, url, hash));
      if (p.website !== null) stmts.push(db.prepare(Q.websiteDueUpsert.sql).bind(now, tx, ix, url, hash));
    } else {
      stmts.push(db.prepare(Q.profileDueRetry.sql).bind(now + PROFILE_RETRY_MS, tx, ix, url, hash));
    }
  }
  await writeBatch(db, lease, stmts);
}

/** Listed groups whose website check is due, oldest due first. Pass the lease to clear stale due rows. */
export async function websitesToCheck(
  db: D1Database,
  now: number,
  limit: number,
  lease?: string,
): Promise<Array<{ groupId: string; website: string }>> {
  const rows = await duePage(db, Q.websiteDuePage.sql, Q.websiteDueDropStale.sql, now, limit, lease);
  return rows
    .filter((r) => !r.stale)
    .map((r) => ({ groupId: groupIdString(refFromCols(r.group_tx, r.group_ix)), website: String(r.website) }));
}

/** Records a website check and schedules the next one WEBSITE_RECHECK_MS later. */
export async function setWebsiteCheck(db: D1Database, lease: string, groupId: string, verified: boolean, at: number): Promise<void> {
  const [tx, ix] = groupKey(groupId);
  await writeBatch(db, lease, [
    db.prepare(Q.websiteCheck.sql).bind(at, verified ? 1 : 0, at, tx, ix),
    db.prepare(Q.websiteDueMove.sql).bind(at + WEBSITE_RECHECK_MS, tx, ix),
  ]);
}
