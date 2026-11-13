// Query params of the Positions tab on a governance topic: which voter list is
// shown (`role`) and how the DRep list is ordered (`sort`). Both travel in the
// URL, so the per-URL page cache stays correct for anonymous readers.

export type PositionsRole = 'drep' | 'spo' | 'cc';

/** Reads the `role` query param. Anything but 'spo' or 'cc' is the DRep list. */
export function parsePositionsRole(raw: string | null | undefined): PositionsRole {
  return raw === 'spo' || raw === 'cc' ? raw : 'drep';
}

export type VoterSort = 'recent' | 'power';

/** Sort options of the DRep list with their control labels, in display order. */
export const VOTER_SORTS: readonly { mode: VoterSort; label: string }[] = [
  { mode: 'recent', label: 'Newest' },
  { mode: 'power', label: 'Voting power' },
];

/** What a reader sees without a `sort` param: the newest votes first. */
export const DEFAULT_VOTER_SORT: VoterSort = 'recent';

/** Reads the `sort` query param. A missing or unknown value is the default. */
export function parseVoterSort(raw: string | null | undefined): VoterSort {
  return VOTER_SORTS.find((s) => s.mode === raw)?.mode ?? DEFAULT_VOTER_SORT;
}
