/// <reference types="@cloudflare/workers-types" />
// Resolves the single most-recent pending event for one channel into a push
// title + body plus the in-app path to open, so a small bundle can be spelled
// out with a deep link instead of a bare count (see pushMessage.formatNotification).
//
// This mirrors the inbox row hydration in src/pages/notifications.astro, but for
// exactly ONE item: the dispatcher only asks for the lead when a channel has at
// most DETAIL_MAX pending events, so at most one topic / actor / action lookup
// runs per delivered channel. Eligibility (created_at / notified_at vs the
// delivery cursor, prefs gating) matches getPendingCounts so the lead can never
// name an event the counts did not include.

import type { NotificationChannelRow, NotificationEventType } from '../db/notificationChannels.js';
import type { PendingLead } from './pushMessage.js';
import { sqlPlaceholders } from '../db/sql.js';
import { getTopicsByIds } from '../db/forum.js';
import { getGovernanceActionSlugsByIds } from '../db/governance.js';
import { loadAuthorIdentity } from '../forum/author.js';
import { statusBadge } from '../governance/view.js';
import { voteStatementPath } from '../governance/voteStatement.js';
import { parseDrepEventPayload } from '../delegation/notifyPayload.js';
import { parseDrepStatsPayload, formatDrepStatsDetail } from './drepStats.js';
import { drepPath } from '../dreps/profile.js';

const INBOX_PATH = '/notifications/';

// Personal notification type -> the pref that gates it. device_paired is absent
// on purpose: it is a security notice and never pref-gated, so it is always
// eligible (mirrors getPendingCounts, where the device term ignores prefs).
const PERSONAL_PREF: Record<string, NotificationEventType | 'always'> = {
  reply: 'reply',
  mention: 'mention',
  delegator_drep_voted: 'drep_activity',
  delegator_drep_re_voted: 'drep_activity',
  delegator_drep_status_changed: 'drep_status',
  delegation_changed: 'my_delegation',
  drep_stats: 'drep_stats',
  rationale_ready: 'rationale_ready',
  device_paired: 'always',
};

// Long governance titles would blow past a push notification's visible width;
// clip to a readable length with an ellipsis (not a dash).
function clip(text: string, max = 80): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

interface PersonalRow {
  type: string;
  actor_id: string | null;
  topic_id: string | null;
  post_id: string | null;
  payload: string | null;
  created_at: number;
}

interface GovRow {
  type: 'gov_created' | 'gov_status';
  topic_id: string;
  payload: string | null;
  at: number;
}

/**
 * Finds the newest pending event for the channel (personal or governance) and
 * hydrates it into a lead sentence + deep-link path. Returns null when nothing
 * qualifies or the winning event cannot be hydrated (e.g. its topic was
 * deleted), in which case the caller falls back to the count summary.
 */
export async function resolvePendingLead(
  db: D1Database,
  row: NotificationChannelRow,
  prefs: Record<NotificationEventType, boolean>,
): Promise<PendingLead | null> {
  const cursor = row.delivered_until;

  // Only consider personal types whose pref is on (device_paired always).
  const allowedPersonal = Object.entries(PERSONAL_PREF)
    .filter(([, pref]) => pref === 'always' || prefs[pref])
    .map(([type]) => type);

  const personal = allowedPersonal.length
    ? await db
        .prepare(
          `SELECT type, actor_id, topic_id, post_id, payload, created_at
             FROM notifications
            WHERE recipient_id = ?1 AND created_at > ?2
              AND type IN (${sqlPlaceholders(allowedPersonal)})
            ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(row.user_id, cursor, ...allowedPersonal)
        .first<PersonalRow>()
    : null;

  const gov = prefs.governance
    ? await db
        .prepare(
          // Bare notified_at, matching govThreadsSinceSql: an expression over the
          // column would not be sargable and would skip idx_activity_notified.
          `SELECT a.type AS type, a.topic_id AS topic_id, a.payload AS payload,
                  a.notified_at AS at
             FROM activity a JOIN topics t ON t.id = a.topic_id
            WHERE a.type IN ('gov_created', 'gov_status')
              AND t.deleted = 0
              AND a.notified_at > ?1
            ORDER BY at DESC LIMIT 1`,
        )
        .bind(cursor)
        .first<GovRow>()
    : null;

  // Pick the newer of the two candidates.
  const personalAt = personal?.created_at ?? -1;
  const govAt = gov?.at ?? -1;
  if (personalAt < 0 && govAt < 0) return null;

  return govAt >= personalAt ? hydrateGov(db, gov!) : hydratePersonal(db, personal!);
}

async function hydrateGov(db: D1Database, row: GovRow): Promise<PendingLead | null> {
  const topic = (await getTopicsByIds(db, [row.topic_id])).get(row.topic_id);
  if (!topic || topic.deleted) return null;
  const href = `/t/${topic.slug}/`;

  if (row.type === 'gov_status') {
    // Subject in the title, the new status as the news below it.
    const to = readString(row.payload, 'to');
    const status = to ? statusBadge(to).label : null;
    return { title: clip(topic.title), body: status ? `Now ${status}` : 'Status updated', href };
  }
  // gov_created: the action title rides in the payload (see governance/sync.ts),
  // so no extra read; fall back to the topic title if an older row lacks it.
  const title = readString(row.payload, 'title') ?? topic.title;
  return { title: clip(title), body: 'New governance action', href };
}

async function hydratePersonal(db: D1Database, row: PersonalRow): Promise<PendingLead | null> {
  switch (row.type) {
    case 'device_paired':
      return { title: 'New device paired', body: 'Tap to review your devices', href: '/devices/' };

    case 'delegation_changed':
      return { title: 'Delegation changed', body: 'Tap to review your delegation', href: '/home/' };

    case 'delegator_drep_voted':
    case 'delegator_drep_re_voted': {
      const p = parseDrepEventPayload(row.payload);
      // Newer payloads carry the cast choice, so the message can say "voted Yes"
      // instead of just "voted"; older rows fall back to the bare verb.
      const verb =
        row.type === 'delegator_drep_voted'
          ? p?.vote
            ? `Your DRep voted ${p.vote}`
            : 'Your DRep voted'
          : p?.vote
            ? `Your DRep changed a vote to ${p.vote}`
            : 'Your DRep changed a vote';
      const slug = p?.gaId ? (await getGovernanceActionSlugsByIds(db, [p.gaId])).get(p.gaId) : null;
      const href = slug ? `/t/${slug}/` : INBOX_PATH;
      // With the action known it is the subject (title); otherwise the verb leads.
      return p?.title
        ? { title: clip(p.title), body: verb, href }
        : { title: verb, body: 'on a governance action', href };
    }

    case 'delegator_drep_status_changed': {
      const p = parseDrepEventPayload(row.payload);
      if (!p?.drepId || !p.to) return null;
      return {
        title: 'DRep status changed',
        body: `Your DRep is now ${p.to.effective}`,
        href: drepPath({ drepId: p.drepId }),
      };
    }

    case 'drep_stats': {
      const p = parseDrepStatsPayload(row.payload);
      if (!p) return null;
      const detail = formatDrepStatsDetail(p);
      return {
        title: `Epoch ${p.epoch} · DRep stats`,
        body: detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : 'Stats updated',
        href: drepPath({ drepId: p.drepId }),
      };
    }

    case 'rationale_ready': {
      // The DRep's own vote confirmed on chain: deep-link to the shareable
      // vote page. Without a live thread slug the inbox is the fallback.
      const p = parseDrepEventPayload(row.payload);
      if (!p?.gaId || !p.drepId) return null;
      const slug = (await getGovernanceActionSlugsByIds(db, [p.gaId])).get(p.gaId);
      const href = slug ? voteStatementPath('drep', p.drepId, slug) : INBOX_PATH;
      return p.title
        ? { title: clip(p.title), body: 'Your rationale is ready to share', href }
        : { title: 'Your rationale is ready to share', body: 'Your vote is confirmed on chain', href };
    }

    default: {
      // reply / mention: the thread is the subject (title), the actor's action
      // the body. Deep-links to the post.
      if (!row.topic_id) return null;
      const topic = (await getTopicsByIds(db, [row.topic_id])).get(row.topic_id);
      if (!topic || topic.deleted) return null;
      const actor = row.actor_id ? (await loadAuthorIdentity(db, row.actor_id)).displayName : null;
      const isMention = row.type === 'mention';
      const body = actor
        ? `${actor} ${isMention ? 'mentioned you' : 'replied'}`
        : `New ${isMention ? 'mention' : 'reply'}`;
      const tab = topic.source === 'governance' ? '?tab=discussion' : '';
      const anchor = row.post_id ? `#post-${row.post_id}` : '';
      return { title: `"${clip(topic.title)}"`, body, href: `/t/${topic.slug}/${tab}${anchor}` };
    }
  }
}

/** Reads one string field out of a JSON payload, tolerating null/garbage. */
function readString(payload: string | null, key: string): string | null {
  if (!payload) return null;
  try {
    const v = (JSON.parse(payload) as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
