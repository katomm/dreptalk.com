// Ordering of the DRep directory. DReps who vote regularly (the first group) come
// first in an order that changes daily, everyone else follows by participation.
// Pure functions only, no database access.

export type DrepListSort = 'active' | 'power' | 'delegators';

/** Sort options of the DRep list with their control labels, in display order. */
export const DREP_LIST_SORTS: readonly { mode: DrepListSort; label: string }[] = [
  { mode: 'active', label: 'Active first' },
  { mode: 'power', label: 'Voting power' },
  { mode: 'delegators', label: 'Delegators' },
];

/** What a reader sees without a `sort` param. */
export const DEFAULT_DREP_LIST_SORT: DrepListSort = 'active';

/** Reads the `sort` query param. A missing or unknown value is the default. */
export function parseDrepListSort(raw: string | null | undefined): DrepListSort {
  return explicitDrepListSort(raw) ?? DEFAULT_DREP_LIST_SORT;
}

/** The value when `raw` is one of the three sorts, else null. Drives the in-list links. */
export function explicitDrepListSort(raw: string | null | undefined): DrepListSort | null {
  return DREP_LIST_SORTS.find((s) => s.mode === raw)?.mode ?? null;
}

/** Minimum participation (percent) for a DRep to be in the first group. */
export const FIRST_GROUP_MIN_PARTICIPATION_PCT = 70;

export interface DrepOrderRow {
  drepId: string;
  active: boolean;
  hasName: boolean;
  /** Lovelace as text, as stored. */
  votingPower: string | null;
  doNotList: boolean;
  participationPct: number | null;
  rationalePct: number | null;
}

export type FirstGroupMiss =
  | 'inactive' | 'no_name' | 'below_floor' | 'no_report_card' | 'below_threshold' | 'do_not_list';

/** Lovelace text to BigInt, 0n for null or malformed text. */
function parsePower(raw: string | null): bigint {
  if (raw === null) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

/** null when the row is in the first group, else the first failing condition in the order of the union above. */
export function firstGroupMiss(row: DrepOrderRow, floorLovelace: bigint): FirstGroupMiss | null {
  if (!row.active) return 'inactive';
  if (!row.hasName) return 'no_name';
  if (parsePower(row.votingPower) < floorLovelace) return 'below_floor';
  if (row.participationPct === null) return 'no_report_card';
  if (row.participationPct < FIRST_GROUP_MIN_PARTICIPATION_PCT) return 'below_threshold';
  if (row.doNotList) return 'do_not_list';
  return null;
}

/** 'YYYY-MM-DD' in UTC. */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** A percent for display, rounded down, so 69.5 never reads as 70. */
export function wholePercent(pct: number): number {
  return Math.floor(pct);
}

// FNV-1a over the UTF-16 code units of "<day>:<drepId>", as an unsigned 32-bit integer.
function dayHash(day: string, drepId: string): number {
  const text = `${day}:${drepId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The first group in a per-day order, then everyone else by participation
 * (no report card last), power and id. Independent of the input order.
 */
export function orderDrepList(
  rows: DrepOrderRow[],
  opts: { day: string; floorLovelace: bigint },
): { ids: string[]; firstGroupSize: number } {
  const first: { id: string; hash: number }[] = [];
  const rest: { id: string; pct: number | null; power: bigint }[] = [];
  for (const row of rows) {
    if (firstGroupMiss(row, opts.floorLovelace) === null) {
      first.push({ id: row.drepId, hash: dayHash(opts.day, row.drepId) });
    } else {
      rest.push({ id: row.drepId, pct: row.participationPct, power: parsePower(row.votingPower) });
    }
  }
  first.sort((a, b) => a.hash - b.hash || compareId(a.id, b.id));
  rest.sort((a, b) => {
    if (a.pct !== b.pct) {
      if (a.pct === null) return 1;
      if (b.pct === null) return -1;
      return b.pct - a.pct;
    }
    if (a.power !== b.power) return a.power > b.power ? -1 : 1;
    return compareId(a.id, b.id);
  });
  return { ids: [...first, ...rest].map((r) => r.id), firstGroupSize: first.length };
}

export interface DrepListUrlState {
  /** The valid `sort` the URL carries, or null for a bare URL. From explicitDrepListSort. */
  sortInUrl: DrepListSort | null;
  /** True when the URL has all=1. */
  all: boolean;
  /** Group id string of the group filter, or null. */
  group: string | null;
}

/**
 * Href of a link inside the list: always the full path "/dreps/" plus the query, never a bare
 * query string. An empty href would resolve to the current URL and keep its query.
 * Param order: page, all, sort, group. `change.sort` is the sort control: always explicit, page dropped.
 */
export function drepListHref(
  state: DrepListUrlState,
  change: { sort?: DrepListSort; all?: boolean; group?: null; page?: number } = {},
): string {
  const all = change.all ?? state.all;
  const sort = change.sort ?? state.sortInUrl;
  const group = change.group === null ? null : state.group;
  const parts: string[] = [];
  if (change.sort === undefined && change.page !== undefined) parts.push(`page=${change.page}`);
  if (all) parts.push('all=1');
  if (sort) parts.push(`sort=${sort}`);
  // Group ids are bech32, safe in a query without encoding.
  if (group) parts.push(`group=${group}`);
  return parts.length ? `/dreps/?${parts.join('&')}` : '/dreps/';
}

/** The standing line of the signed-in DRep's card in the default view. */
export function firstGroupStandingLine(
  miss: FirstGroupMiss | null,
  participationPct: number | null,
  floorLovelace: bigint,
): string {
  const voted = participationPct === null ? '' : `Voted on ${wholePercent(participationPct)}% of governance actions. `;
  switch (miss) {
    case null:
      return `${voted}In the first group.`;
    case 'inactive':
      return 'Not active, so not in the first group.';
    case 'no_name':
      return 'Not in the first group: your DRep metadata has no name.';
    case 'below_floor':
      return `Not in the first group: voting power is below ${(floorLovelace / 1_000_000n).toLocaleString('en-US')} ada.`;
    case 'no_report_card':
      return 'Not in the first group: no participation figure yet.';
    case 'below_threshold':
      return `${voted}The first group starts at ${FIRST_GROUP_MIN_PARTICIPATION_PCT}%.`;
    case 'do_not_list':
      return 'Not in the first group: your DRep metadata sets doNotList.';
  }
}
