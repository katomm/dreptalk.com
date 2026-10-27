/// <reference types="@cloudflare/workers-types" />
// DRep groups for the pages: bounded readers of groups, members and history, and the profile and
// website due queue with the writes that move its rows. A group id is the bech32 id of the page,
// decoded to the key of the stored group.
import type { EventRef } from 'drep-groups';
import { comparePos, effectiveClose, refKey } from 'drep-groups';
import {
  GROUP_PAGE_SIZE,
  PENDING_INDICATOR_CAP,
  PROFILE_RETRY_MS,
  RETENTION_KEEP_APPLIED,
  RETENTION_KEEP_NOT_APPLIED,
  WEBSITE_RECHECK_MS,
} from '../groups/constants.js';
import { hashBytes, hashFromCol, instanceFromRow, posOrNull, refBinds, refFromCols } from '../groups/codec.js';
import { drepIdForCredential, groupIdParam, groupIdString } from '../groups/ids.js';
import { jobsPending } from '../groups/jobs.js';
import { certPos, countedAs } from '../groups/store/commit.js';
import { guardedBatch, writeBatch } from '../groups/store/lease.js';
import { KEYED, KEYED_WIDTH, Q } from '../groups/store/queries.js';
import { readMeta } from '../groups/store/recovery.js';
import { chunked, D1_MAX_BINDS } from './sql.js';

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
 * One page of a due queue. The stale rows of the page are deleted in the same batch, so rows of
 * unlisted or anchorless groups never pile up in front of the work.
 */
async function duePage(db: D1Database, page: string, dropStale: string, now: number, limit: number, lease: string): Promise<Row[]> {
  const res = await guardedBatch(db, lease, [db.prepare(page).bind(now, limit), db.prepare(dropStale).bind(now, limit)]);
  return (res[1].results as Row[] | undefined) ?? [];
}

/** Listed groups with an anchor whose profile is due, oldest due first. Clears the stale due rows of the page. */
export async function profilesToFetch(
  db: D1Database,
  now: number,
  limit: number,
  lease: string,
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

/** Listed groups whose website check is due, oldest due first. Clears the stale due rows of the page. */
export async function websitesToCheck(
  db: D1Database,
  now: number,
  limit: number,
  lease: string,
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

/** True when the stored profile of the group was fetched from the document with this hash. */
export async function hasProfileFor(db: D1Database, groupId: string, dataHash: string): Promise<boolean> {
  const [tx, ix] = groupKey(groupId);
  return (await db.prepare(Q.profileStored.sql).bind(tx, ix, hashBytes(dataHash)).first()) !== null;
}

/** Keeps the stored profile as it is and only delays its next fetch by PROFILE_RETRY_MS. */
export async function delayProfile(db: D1Database, lease: string, groupId: string, url: string, dataHash: string, now: number): Promise<void> {
  const [tx, ix] = groupKey(groupId);
  await writeBatch(db, lease, [db.prepare(Q.profileDueRetry.sql).bind(now + PROFILE_RETRY_MS, tx, ix, url, hashBytes(dataHash))]);
}

export interface GroupRow {
  groupId: string;
  ref: EventRef;
  mode: 'open' | 'permissioned';
  status: 'active' | 'dissolved';
  seq: string;
  controlHash: string;
  admissionHash: string | null;
  profileUrl: string | null;
  profileHash: string | null;
  createdHeight: number;
  profileSetHeight: number | null;
  members: number;
  pending: number;
  former: number;
  appliedEvents: number;
  notAppliedEvents: number;
  /** Lovelace as decimal text, exact above 2^53. */
  memberPower: string;
  closing: boolean;
}

export interface MemberRow {
  /** refKey of the join event. */
  joinId: string;
  drepId: string;
  drepName: string | null;
  drepSlug: string | null;
  votingPower: string | null;
  state: 'pending' | 'active' | 'closed';
  reason: string | null;
  joinedHeight: number;
  approvedHeight: number | null;
  closedHeight: number | null;
  /** retiring: a retirement close is still being applied. unapplied: a stored ledger row of the member is not applied yet. */
  mark: 'retiring' | 'unapplied' | null;
  /** The join position as a keyset cursor for the next page. */
  key: string;
}

export interface VerdictRow {
  txHash: string;
  eventIndex: number;
  tag: string | null;
  valid: boolean;
  reason: string | null;
  blockHeight: number;
}

export type StatusNote = 'correcting' | 'rebuilding' | null;

const optHash = (v: unknown): string | null => (v === null || v === undefined ? null : hashFromCol(v));
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function groupFromRow(r: Row): GroupRow {
  const ref = refFromCols(r.group_tx, r.group_ix);
  return {
    groupId: groupIdString(ref),
    ref,
    mode: String(r.mode) as GroupRow['mode'],
    status: String(r.status) as GroupRow['status'],
    seq: String(r.seq),
    controlHash: hashFromCol(r.control),
    admissionHash: optHash(r.admission),
    profileUrl: optStr(r.profile_url),
    profileHash: optHash(r.profile_hash),
    createdHeight: Number(r.created_h),
    profileSetHeight: optNum(r.profile_set_h),
    members: Number(r.members),
    pending: Number(r.pending),
    former: Number(r.former),
    appliedEvents: Number(r.applied_events),
    notAppliedEvents: Number(r.not_applied_events),
    memberPower: String(r.member_power),
    closing: Number(r.closing) === 1,
  };
}

function profileFromRow(groupId: string, r: Row): ProfileRow | null {
  if (r.p_gtx === null) return null;
  return {
    groupId,
    profileUrl: optStr(r.p_url),
    dataHash: optHash(r.p_hash),
    status: String(r.p_status),
    name: optStr(r.p_name),
    description: optStr(r.p_description),
    website: optStr(r.p_website),
    image: optStr(r.p_image),
    charter: optStr(r.p_charter),
    paymentAddresses: r.p_payments === null ? [] : (JSON.parse(String(r.p_payments)) as PaymentAddress[]),
    fetchedAt: optNum(r.p_fetched),
    websiteVerifiedAt: optNum(r.p_verified),
    websiteCheckedAt: optNum(r.p_checked),
  };
}

/**
 * The note a group page shows while the stored state is being corrected. A rebuild sets the meta flag
 * until its replay reaches the label frontier again. Any other open recovery slot and any recompute or
 * repair job left behind by one give correcting.
 */
export async function statusNote(db: D1Database): Promise<StatusNote> {
  const meta = await readMeta(db);
  if (Number(meta.rebuilding) === 1) return 'rebuilding';
  if (meta.rec_first_kind !== null) return 'correcting';
  return (await jobsPending(db, ['recompute', 'repair'])) ? 'correcting' : null;
}

/**
 * One page of the groups with at least LISTED_MIN_MEMBERS members, by member power and then group key.
 * `after` is the power and group id of the last row of the previous page.
 */
export async function listListedGroups(
  db: D1Database,
  after: { power: string; groupId: string } | null,
  limit: number,
): Promise<Array<GroupRow & { name: string | null; websiteVerified: boolean }>> {
  // A cursor that does not parse gives the first page, as a member cursor does.
  const ref = after !== null && /^\d+$/.test(after.power) ? groupIdParam(after.groupId) : null;
  let rows: Row[];
  if (after === null || ref === null) {
    rows = (await db.prepare(Q.listedFirst.sql).bind(limit).all<Row>()).results ?? [];
  } else {
    const res = (await db.prepare(Q.listedAfter.sql).bind(after.power, ...refBinds(ref), limit).all<Row>()).results ?? [];
    rows = [...res.filter((r) => Number(r.part) === 0), ...res.filter((r) => Number(r.part) === 1)].slice(0, limit);
  }
  return rows.map((r) => ({ ...groupFromRow(r), name: optStr(r.p_name), websiteVerified: r.p_verified !== null }));
}

/** A group with its stored profile, null for an invalid id or an unknown group. */
export async function getGroup(db: D1Database, groupId: string): Promise<(GroupRow & { profile: ProfileRow | null }) | null> {
  const ref = groupIdParam(groupId);
  if (!ref) return null;
  const r = await db.prepare(Q.groupRow.sql).bind(...refBinds(ref)).first<Row>();
  if (!r) return null;
  const g = groupFromRow(r);
  return { ...g, profile: profileFromRow(g.groupId, r) };
}

type Key = [number, number, number, number];
const START: Key = [-1, -1, -1, -1];

/** The keyset of a member cursor, the first page for anything that is not one. */
function keyFrom(after: string | null): Key {
  const parts = after?.split('.').map(Number) ?? [];
  return parts.length === 4 && parts.every(Number.isSafeInteger) ? (parts as Key) : START;
}

/** Member rows of a page by join position, the state from effectiveClose over the stored instance, never the cache. */
function membersFromRows(rows: Row[]): MemberRow[] {
  return rows
    .map((r) => ({ r, inst: instanceFromRow(r) }))
    .sort((a, b) => comparePos(a.inst.joinedAt, b.inst.joinedAt))
    .map(({ r, inst }) => {
      const eff = effectiveClose(inst, posOrNull(r, 'dis'), r.u_h === null ? null : certPos(r));
      const counted = countedAs(inst, eff);
      const j = inst.joinedAt;
      return {
        joinId: refKey(inst.joinId),
        drepId: String(r.drep_id),
        drepName: optStr(r.drep_name),
        drepSlug: optStr(r.drep_slug),
        votingPower: optStr(r.drep_power),
        state: counted === 'open' ? 'active' : counted === 'pending' ? 'pending' : 'closed',
        reason: eff?.reason ?? null,
        joinedHeight: j.blockHeight,
        approvedHeight: inst.approvedAt?.blockHeight ?? null,
        closedHeight: eff?.at.blockHeight ?? null,
        mark: Number(r.retiring) === 1 ? 'retiring' : Number(r.unapplied) === 1 ? 'unapplied' : null,
        key: `${j.blockHeight}.${j.txIndex}.${j.phase}.${j.index}`,
      };
    });
}

const COUNTED = { active: 'open', pending: 'pending', former: 'former' } as const;

/**
 * One page of a group's members of one kind by join position, filtered by the counted_as cache so the
 * keyset stays stable. A group with closing set uses listClosingMembers instead.
 */
export async function listMembers(
  db: D1Database,
  group: EventRef,
  kind: 'active' | 'pending' | 'former',
  after: string | null,
  limit: number,
): Promise<MemberRow[]> {
  const res = await db.prepare(Q.memberPage.sql).bind(...refBinds(group), COUNTED[kind], ...keyFrom(after), limit).all<Row>();
  return membersFromRows(res.results ?? []);
}

/** One page of all instances of a closing group by join position, each with its state from effectiveClose. */
export async function listClosingMembers(db: D1Database, group: EventRef, after: string | null): Promise<MemberRow[]> {
  const res = await db.prepare(Q.closingMemberPage.sql).bind(...refBinds(group), ...keyFrom(after), GROUP_PAGE_SIZE).all<Row>();
  return membersFromRows(res.results ?? []);
}

/** The newest retained verdicts of one validity class, at most the number retention keeps. */
export async function listVerdicts(db: D1Database, group: EventRef, valid: boolean, limit: number): Promise<VerdictRow[]> {
  const keep = valid ? RETENTION_KEEP_APPLIED : RETENTION_KEEP_NOT_APPLIED;
  const res = await db.prepare(Q.verdictPage.sql).bind(...refBinds(group), valid ? 1 : 0, Math.min(limit, keep)).all<Row>();
  return (res.results ?? []).map((r) => ({
    txHash: hashFromCol(r.tx_hash),
    eventIndex: Number(r.idx),
    tag: optStr(r.tag),
    valid: Number(r.valid) === 1,
    reason: optStr(r.reason),
    blockHeight: Number(r.at_h),
  }));
}

/** Whether the group is closing and how many of its membership events wait for their member, capped. */
export async function pendingVerification(db: D1Database, group: EventRef): Promise<{ closing: boolean; queued: number; capped: boolean }> {
  const r = await db.prepare(Q.pendingVerification.sql).bind(...refBinds(group)).first<Row>();
  const queued = Number(r?.queued ?? 0);
  return { closing: Number(r?.closing ?? 0) === 1, queued, capped: queued >= PENDING_INDICATOR_CAP };
}

/** The active groups the DRep is an open member of, by group key. */
export async function groupsForDrep(db: D1Database, drepId: string, limit: number): Promise<Array<{ groupId: string; name: string | null; mode: string }>> {
  const res = await db.prepare(Q.drepGroups.sql).bind(drepId, limit).all<Row>();
  return (res.results ?? []).map((r) => ({ groupId: groupIdString(refFromCols(r.group_tx, r.group_ix)), name: optStr(r.name), mode: String(r.mode) }));
}

/** Ids of the listed active groups with the most member power. */
export async function listGroupIdsForSitemap(db: D1Database, limit: number): Promise<string[]> {
  const res = await db.prepare(Q.sitemapGroups.sql).bind(limit).all<Row>();
  return (res.results ?? []).map((r) => groupIdString(refFromCols(r.group_tx, r.group_ix)));
}

/** Runs a keyed read over the values in chunks within the bind limit. */
async function keyedRead(db: D1Database, name: 'scriptDisplays' | 'drepNames', values: unknown[]): Promise<Row[]> {
  const chunks = chunked(values, Math.floor(D1_MAX_BINDS / KEYED_WIDTH[name]));
  if (chunks.length === 0) return [];
  const res = await db.batch<Row>(chunks.map((c) => db.prepare(KEYED[name](c.length)).bind(...c)));
  return res.flatMap((r) => r.results ?? []);
}

/** Display JSON of stored native scripts by script hash. Unknown hashes are left out. */
export async function scriptDisplays(db: D1Database, hashes: string[]): Promise<Map<string, string>> {
  const rows = await keyedRead(db, 'scriptDisplays', [...new Set(hashes)].map(hashBytes));
  return new Map(rows.map((r) => [hashFromCol(r.hash), String(r.display_json)]));
}

/** Names of the DReps whose key credential is one of the key hashes, by key hash. */
export async function drepNamesForKeyHashes(db: D1Database, keyHashes: string[]): Promise<Map<string, string>> {
  const byDrep = new Map([...new Set(keyHashes)].map((h) => [drepIdForCredential({ kind: 'key', hash: h }), h]));
  const rows = await keyedRead(db, 'drepNames', [...byDrep.keys()]);
  return new Map(rows.map((r) => [byDrep.get(String(r.drep_id)) as string, String(r.name)]));
}
