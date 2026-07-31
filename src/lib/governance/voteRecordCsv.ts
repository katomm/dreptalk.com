// CSV export of a DRep's voting record, built from the same DrepVoteHistoryRow
// list the dashboard renders. Pure (no I/O) so the route stays a thin wrapper
// and the column shape is unit-tested directly.
import { readableType, shortGovActionId } from './view.js';
import { csvField } from '@/lib/format/csv.js';
import { isoDate } from '@/lib/format/date.js';
import type { DrepVoteHistoryRow } from '@/lib/db/drepVotes.js';

/** Vote tx unix seconds to an ISO date (YYYY-MM-DD); empty when unknown. */
function voteDate(blockTime: number | null): string {
  return blockTime == null ? '' : isoDate(new Date(blockTime * 1000));
}

/**
 * The rationale link for a row: the on-site vote page when a rationale is stored
 * and the action has both a slug and a share base, else the raw on-chain anchor,
 * else empty. Absolute (resolved against `origin`) so the exported file's links
 * work standalone.
 */
function rationaleUrl(
  row: DrepVoteHistoryRow,
  origin: string,
  voteShareBase: string | null,
): string {
  if (voteShareBase && row.rationale_html && row.topic_slug) {
    return new URL(`${voteShareBase}${row.topic_slug}/`, origin).toString();
  }
  return row.meta_url ?? '';
}

export interface VoteRecordCsvOptions {
  /** Absolute origin (e.g. https://dreptalk.com) to resolve on-site links. */
  origin: string;
  /** Base path for this DRep's shareable vote pages, or null when unavailable. */
  voteShareBase: string | null;
}

const HEADER = 'Epoch,Date,Type,Vote,Title,Rationale URL';

/**
 * Builds the CSV text (CRLF-joined) for a DRep's voting record. One row per
 * cast vote, newest first (the caller passes rows already ordered). Columns:
 * decided epoch, vote date, readable action type, vote, action title, and the
 * rationale link.
 */
export function buildVoteRecordCsv(
  rows: DrepVoteHistoryRow[],
  opts: VoteRecordCsvOptions,
): string {
  const lines = rows.map((row) =>
    [
      row.decided_epoch != null ? String(row.decided_epoch) : '',
      voteDate(row.block_time),
      csvField(readableType(row.type)),
      csvField(row.vote),
      csvField(row.title ?? shortGovActionId(row.ga_id)),
      csvField(rationaleUrl(row, opts.origin, opts.voteShareBase)),
    ].join(','),
  );
  return [HEADER, ...lines].join('\r\n');
}
