// Pure view-model for the profile's merged recent-activity list: votes,
// published rationales, and forum posts folded into one timeline. No I/O.
import type { DrepVoteHistoryRow } from '../db/drepVotes.js';
import type { AuthorPost } from '../db/forum.js';
import { epochFromUnix, type NetworkConfig } from '../config/network.js';
import { excerptFromHtml } from '../forum/view.js';

/**
 * One row of the recent-activity list. `ts` is unix ms across all kinds. `key`
 * groups the events of one subject (the action id for votes/rationales, the
 * post id for discussions) so a rationale stays glued under its vote even when
 * a multi-vote transaction stamps several votes with one block_time.
 */
export type ActivityEvent =
  | { kind: 'vote'; ts: number; key: string; vote: string; title: string; href: string | null; epoch: number }
  | { kind: 'rationale'; ts: number; key: string; title: string; href: string | null }
  | { kind: 'discussion'; ts: number; key: string; started: boolean; title: string; href: string; excerpt: string };

// Fixed order at equal timestamps within one subject: the vote renders directly
// above the rationale published with it. Never database row order.
const KIND_RANK: Record<ActivityEvent['kind'], number> = { vote: 0, rationale: 1, discussion: 2 };

/**
 * Merges the three activity sources into one newest-first list. A vote that
 * carries a rationale yields two events sharing the vote's timestamp (that is
 * intended: casting and explaining are both activity). `profilePath` is the
 * canonical profile path ("/dreps/<slug>/") for the per-vote rationale links.
 */
export function buildRecentActivity(
  input: { votes: DrepVoteHistoryRow[]; posts: AuthorPost[]; profilePath: string; cfg: NetworkConfig },
  limit = 5,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const v of input.votes) {
    if (v.block_time == null) continue; // no timestamp, cannot place on a timeline
    const ts = v.block_time * 1000;
    const title = v.title ?? v.ga_id;
    const actionHref = v.topic_slug ? `/t/${v.topic_slug}/` : null;
    events.push({ kind: 'vote', ts, key: v.ga_id, vote: v.vote, title, href: actionHref, epoch: epochFromUnix(v.block_time, input.cfg) });
    if (v.rationale_html) {
      const href = v.topic_slug ? `${input.profilePath}vote/${v.topic_slug}/` : actionHref;
      events.push({ kind: 'rationale', ts, key: v.ga_id, title, href });
    }
  }

  for (const p of input.posts) {
    events.push({
      kind: 'discussion',
      ts: p.created_at,
      key: p.id,
      started: p.is_topic_start === 1,
      title: p.topic_title,
      href: `/t/${p.topic_slug}/#post-${p.id}`,
      excerpt: excerptFromHtml(p.body_html, 160),
    });
  }

  // At an equal timestamp (a multi-vote tx), cluster by subject first so each
  // vote+rationale pair stays adjacent, then order within the pair by kind.
  events.sort(
    (a, b) => b.ts - a.ts || a.key.localeCompare(b.key) || KIND_RANK[a.kind] - KIND_RANK[b.kind],
  );
  return events.slice(0, limit);
}
