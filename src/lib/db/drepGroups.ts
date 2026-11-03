/// <reference types="@cloudflare/workers-types" />
// DRep groups for the pages: bounded readers of groups, members and history, and the profile and
// website due queue with the writes that move its rows. A group id is the bech32 id of the page,
// decoded to the key of the stored group.
import type { EventRef, NativeScript } from 'drep-groups';
import { comparePos, effectiveClose, parseNativeScript, refKey } from 'drep-groups';
import {
  GROUP_PAGE_SIZE,
  PENDING_INDICATOR_CAP,
  PROFILE_RETRY_MS,
  RETENTION_KEEP_APPLIED,
  RETENTION_KEEP_NOT_APPLIED,
  WEBSITE_RECHECK_MS,
} from '../groups/constants.js';
import {
  bytesFromCol,
  hashBytes,
  hashFromCol,
  instanceFromRow,
  type Key,
  optHashFromCol,
  posOrNull,
  refBinds,
  refFromCols,
  type Row,
  START,
} from '../groups/codec.js';
import { openControlAction } from '../groups/actionStore.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam, groupIdString } from '../groups/ids.js';
import { picked } from '../groups/jobs.js';
import { noKeys } from '../groups/preview.js';
import { certPos, countedAs } from '../groups/store/commit.js';
import { guardedBatch, writeBatch } from '../groups/store/lease.js';
import { KEYED, KEYED_WIDTH, Q } from '../groups/store/queries.js';
import { load } from '../groups/store/reads.js';
import { policyKeyHashes, scriptFromJson } from '../groups/view.js';
import type { GroupActionKind } from './pendingMultisigTx.js';
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

/**
 * Runs a page read and gives the fallback when a groups table is missing, so a page shared with the
 * rest of the site stays up until the migration is applied. Logs one line then. Any other error is
 * rethrown.
 */
async function pageRead<T, F>(name: string, fallback: F, read: () => Promise<T>): Promise<T | F> {
  try {
    return await read();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('no such table')) throw err;
    console.error(`[drep-groups] ${name} read failed: ${message}`);
    return fallback;
  }
}

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

interface VerdictRow {
  txHash: string;
  eventIndex: number;
  tag: string | null;
  valid: boolean;
  reason: string | null;
  blockHeight: number;
}

export type StatusNote = 'correcting' | 'rebuilding' | null;

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
    admissionHash: optHashFromCol(r.admission ?? null),
    profileUrl: optStr(r.profile_url),
    profileHash: optHashFromCol(r.profile_hash ?? null),
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
    dataHash: optHashFromCol(r.p_hash ?? null),
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
  const [m, j] = await db.batch<Row>([db.prepare(Q.metaRow.sql), db.prepare(Q.jobPick.sql)]);
  const meta = m.results?.[0];
  if (!meta) throw new Error('drep group meta row missing');
  if (Number(meta.rebuilding) === 1) return 'rebuilding';
  if (meta.rec_first_kind !== null) return 'correcting';
  const pick = j.results?.[0];
  return pick !== undefined && (picked(pick, 'recompute') || picked(pick, 'repair')) ? 'correcting' : null;
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
  return pageRead('listed groups', [], async () => {
    // A cursor that does not parse gives the first page, as a member cursor does.
    const ref = after !== null && /^\d+$/.test(after.power) ? groupIdParam(after.groupId) : null;
    let rows: Row[];
    if (after === null || ref === null) {
      rows = (await db.prepare(Q.listedFirst.sql).bind(limit).all<Row>()).results ?? [];
    } else {
      const res = (await db.prepare(Q.listedAfter.sql).bind(after.power, ...refBinds(ref), limit).all<Row>()).results ?? [];
      rows = res.sort(listedOrder).slice(0, limit);
    }
    return rows.map((r) => ({ ...groupFromRow(r), name: optStr(r.p_name), websiteVerified: r.p_verified !== null }));
  });
}

/** The order of a later listed page: the part, then member power descending, then the group key. */
function listedOrder(a: Row, b: Row): number {
  const pa = BigInt(String(a.member_power));
  const pb = BigInt(String(b.member_power));
  const ka = hashFromCol(a.group_tx);
  const kb = hashFromCol(b.group_tx);
  return (
    Number(a.part) - Number(b.part) ||
    (pa > pb ? -1 : pa < pb ? 1 : 0) ||
    (ka < kb ? -1 : ka > kb ? 1 : 0) ||
    Number(a.group_ix) - Number(b.group_ix)
  );
}

/** A group with its stored profile, null for an invalid id or an unknown group, undefined while the groups tables are missing. */
export async function getGroup(db: D1Database, groupId: string): Promise<(GroupRow & { profile: ProfileRow | null }) | null | undefined> {
  const ref = groupIdParam(groupId);
  if (!ref) return null;
  return pageRead('group', undefined, async () => {
    const r = await db.prepare(Q.groupRow.sql).bind(...refBinds(ref)).first<Row>();
    if (!r) return null;
    const g = groupFromRow(r);
    return { ...g, profile: profileFromRow(g.groupId, r) };
  });
}

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
        // A closed row stays closed whatever the retirement does, only a pending or active one is marked.
        mark: Number(r.retiring) === 1 && counted !== 'former' ? 'retiring' : Number(r.unapplied) === 1 ? 'unapplied' : null,
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
  const res = await db.prepare(Q.verdictPage.sql).bind(...refBinds(group), valid ? 1 : 0, Math.max(0, Math.min(limit, keep))).all<Row>();
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
  return pageRead('DRep groups', [], async () => {
    const res = await db.prepare(Q.drepGroups.sql).bind(drepId, limit).all<Row>();
    return (res.results ?? []).map((r) => ({ groupId: groupIdString(refFromCols(r.group_tx, r.group_ix)), name: optStr(r.name), mode: String(r.mode) }));
  });
}

/** Ids of the listed active groups with the most member power. */
export async function listGroupIdsForSitemap(db: D1Database, limit: number): Promise<string[]> {
  return pageRead('sitemap groups', [], async () => {
    const res = await db.prepare(Q.sitemapGroups.sql).bind(limit).all<Row>();
    return (res.results ?? []).map((r) => groupIdString(refFromCols(r.group_tx, r.group_ix)));
  });
}

/** Runs a keyed read over the values in chunks within the bind limit. */
async function keyedRead(db: D1Database, name: 'scriptDisplays' | 'treasuryScripts' | 'drepNames', values: unknown[]): Promise<Row[]> {
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

/**
 * Stored native scripts by script hash in one read: their display JSON, and the scripts parsed from their bytes.
 * Unknown hashes, missing displays and bytes that do not parse are left out.
 */
export async function treasuryScripts(db: D1Database, hashes: string[]): Promise<{ displays: Map<string, string>; scripts: Map<string, NativeScript> }> {
  const rows = await keyedRead(db, 'treasuryScripts', [...new Set(hashes)].map(hashBytes));
  const displays = new Map<string, string>();
  const scripts = new Map<string, NativeScript>();
  for (const r of rows) {
    const hash = hashFromCol(r.hash);
    if (r.display_json !== null) displays.set(hash, String(r.display_json));
    const script = parseNativeScript(bytesFromCol(r.bytes));
    if (script) scripts.set(hash, script);
  }
  return { displays, scripts };
}

/** Names of the DReps whose key credential is one of the key hashes, by key hash. */
export async function drepNamesForKeyHashes(db: D1Database, keyHashes: string[]): Promise<Map<string, string>> {
  const byDrep = new Map([...new Set(keyHashes)].map((h) => [drepIdForCredential({ kind: 'key', hash: h }), h]));
  const rows = await keyedRead(db, 'drepNames', [...byDrep.keys()]);
  return new Map(rows.map((r) => [byDrep.get(String(r.drep_id)) as string, String(r.name)]));
}

/** An unresolved group row of the signing table as the group page and the DRep profile show it. */
export interface GroupActionRow {
  id: string;
  kind: GroupActionKind;
  status: 'collecting' | 'submitted' | 'cancelled';
  subjectKind: 'member' | 'group';
  /** The group the action is about, for a create the group it founds. */
  groupId: string;
  controlSlot: boolean;
  createdBy: string;
  requiredSigners: string[];
}

const ROW_COLS = `id, action, status, subject_kind, drep_id, control_slot, created_by, required_signers, created_at,
  json_extract(action_params, '$.group') AS grp`;

// Binds the group id and the limit. Unresolved rows whose subject is the group, a create included.
const GROUP_ROWS_SQL = `SELECT ${ROW_COLS} FROM pending_multisig_tx
  WHERE subject_kind = 'group' AND drep_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT ?`;
// Binds the member DRep id, the group id and the limit. The member's own unresolved join and leave rows of the group.
const MEMBER_ROWS_SQL = `SELECT ${ROW_COLS} FROM pending_multisig_tx
  WHERE subject_kind = 'member' AND drep_id = ?1 AND resolved_at IS NULL AND json_extract(action_params, '$.group') = ?2
  ORDER BY created_at DESC LIMIT ?3`;
/**
 * Binds the DRep id, its key hash (NULL for a script DRep) and the limit. Its own member rows, and
 * every unresolved group row that lists its key as a required signer, which covers a joint create
 * before the group exists. Cancelled rows are left out.
 */
export const UNRESOLVED_FOR_DREP_SQL = `SELECT ${ROW_COLS} FROM pending_multisig_tx
    WHERE subject_kind = 'member' AND drep_id = ?1 AND resolved_at IS NULL AND status != 'cancelled'
  UNION
  SELECT ${ROW_COLS} FROM pending_multisig_tx INDEXED BY pending_multisig_tx_unresolved
    WHERE subject_kind != 'drep' AND resolved_at IS NULL AND status != 'cancelled'
      AND EXISTS (SELECT 1 FROM json_each(required_signers) j WHERE j.value = ?2)
  ORDER BY created_at DESC LIMIT ?3`;

/** Rows per list the group page and the profile read, far above what a group has open at once. */
const ACTION_ROWS_LIMIT = 20;
/** Members per list the action island reads, one more than a policy can hold. */
const ACTION_MEMBERS_LIMIT = 65;

function actionRowFrom(r: Row): GroupActionRow {
  const subjectKind = String(r.subject_kind) as GroupActionRow['subjectKind'];
  return {
    id: String(r.id),
    kind: String(r.action) as GroupActionKind,
    status: String(r.status) as GroupActionRow['status'],
    subjectKind,
    groupId: subjectKind === 'group' ? String(r.drep_id) : String(r.grp ?? ''),
    controlSlot: Number(r.control_slot) === 1,
    createdBy: String(r.created_by),
    requiredSigners: r.required_signers === null ? [] : (JSON.parse(String(r.required_signers)) as string[]),
  };
}

/** The unresolved group rows of a DRep, newest first: its join and leave rows and the rows its key must sign. */
export async function unresolvedGroupActionsForDrep(db: D1Database, drepId: string): Promise<GroupActionRow[]> {
  const cred = credentialForDrepId(drepId);
  if (!cred) return [];
  const key = cred.kind === 'key' ? cred.hash.toLowerCase() : null;
  return pageRead('DRep group actions', [], async () => {
    const res = await db.prepare(UNRESOLVED_FOR_DREP_SQL).bind(drepId, key, ACTION_ROWS_LIMIT).all<Row>();
    return (res.results ?? []).map(actionRowFrom);
  });
}

export interface PolicyKeys {
  hash: string;
  /** Display JSON of the native script, empty when the store does not hold it. */
  json: string;
  keys: string[];
}

export interface GroupActionState {
  control: PolicyKeys;
  admission: PolicyKeys | null;
  /** DRep names by key hash, for policy keys and members. */
  names: Map<string, string>;
  openControl: GroupActionRow | null;
  /** Unresolved rows whose subject is the group. */
  rows: GroupActionRow[];
  /** The viewer's own unresolved join and leave rows of the group. */
  viewerRows: GroupActionRow[];
  activeKeyMembers: Array<{ drepId: string; keyHash: string; name: string | null }>;
  pending: Array<{ joinId: string; drepId: string; name: string | null }>;
  viewerJoin: { joinId: string; state: 'pending' | 'active' } | null;
}

/**
 * What the action island of a group page needs: the policies and their keys, the open control
 * action, the unresolved rows of the group and the viewer's own rows, the active key DRep members
 * and the pending requests, and the viewer's open membership.
 */
export async function groupActionState(
  db: D1Database,
  group: GroupRow,
  viewer: { drepId: string | null },
): Promise<GroupActionState> {
  const hashes = [group.controlHash, ...(group.admissionHash ? [group.admissionHash] : [])];
  const cred = viewer.drepId ? credentialForDrepId(viewer.drepId) : null;
  const viewerCred = cred ? { kind: cred.kind, hash: cred.hash.toLowerCase() } : null;
  const [displays, openControl, rows, viewerRows, active, pending, view] = await Promise.all([
    scriptDisplays(db, hashes),
    openControlAction(db, group.groupId),
    db.prepare(GROUP_ROWS_SQL).bind(group.groupId, ACTION_ROWS_LIMIT).all<Row>(),
    viewer.drepId
      ? db.prepare(MEMBER_ROWS_SQL).bind(viewer.drepId, group.groupId, ACTION_ROWS_LIMIT).all<Row>()
      : Promise.resolve({ results: [] as Row[] }),
    listMembers(db, group.ref, 'active', null, ACTION_MEMBERS_LIMIT),
    listMembers(db, group.ref, 'pending', null, ACTION_MEMBERS_LIMIT),
    viewerCred
      ? load(db, { ...noKeys(), latestInstances: [[group.ref, viewerCred]] }, [])
      : Promise.resolve(null),
  ]);
  const policy = (hash: string): PolicyKeys => {
    const json = displays.get(hash) ?? '';
    return { hash, json, keys: policyKeyHashes(scriptFromJson(json || undefined)) };
  };
  const control = policy(group.controlHash);
  const admission = group.admissionHash ? policy(group.admissionHash) : null;

  const activeKeyMembers = active.flatMap((m) => {
    const c = credentialForDrepId(m.drepId);
    return c?.kind === 'key' ? [{ drepId: m.drepId, keyHash: c.hash.toLowerCase(), name: m.drepName }] : [];
  });
  const names = await drepNamesForKeyHashes(db, [...new Set([...control.keys, ...(admission?.keys ?? [])])]);
  for (const m of activeKeyMembers) if (m.name) names.set(m.keyHash, m.name);

  const inst = view && viewerCred ? view.latestInstance(group.ref, viewerCred) : null;
  const viewerJoin =
    inst && inst.closedAt === null ? { joinId: refKey(inst.joinId), state: countedAs(inst, null) === 'open' ? ('active' as const) : ('pending' as const) } : null;

  return {
    control,
    admission,
    names,
    openControl: openControl ? actionRowFrom({ ...openControl, grp: null } as unknown as Row) : null,
    rows: (rows.results ?? []).map(actionRowFrom),
    viewerRows: (viewerRows.results ?? []).map(actionRowFrom),
    activeKeyMembers,
    pending: pending.map((m) => ({ joinId: m.joinId, drepId: m.drepId, name: m.drepName })),
    viewerJoin,
  };
}
