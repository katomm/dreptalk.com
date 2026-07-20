/// <reference types="@cloudflare/workers-types" />
// Write-time notification fan-out. Called from the forum handlers after a
// post exists; failures here must never fail the post, so callers wrap these
// in try/catch. Broadcast gov events are intentionally absent: the inbox
// merges those from the activity table at read time.

import { insertNotifications } from '../db/notifications.js';
import { getThreadParticipantIds } from '../db/forum.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';

/**
 * Notifies everyone participating in a thread about a new reply: the topic
 * author plus every prior poster, deduplicated (getThreadParticipantIds).
 * Excluded: the actor, the two system authors (the gov-sync author owns
 * governance topics; 'system' is the seeded DRepTalk account from migration
 * 0001), and excludeUserIds (mention recipients, who already get the more
 * specific mention notification).
 */
export async function notifyReply(
  db: D1Database,
  args: { topicId: string; postId: string; actorId: string; now: number; excludeUserIds?: string[] },
): Promise<void> {
  const { topicId, postId, actorId, now, excludeUserIds = [] } = args;

  const participants = await getThreadParticipantIds(db, topicId);
  const exclude = new Set([actorId, GOV_SYNC_AUTHOR, 'system', ...excludeUserIds]);
  const recipients = participants.filter((id) => !exclude.has(id));

  await insertNotifications(
    db,
    recipients.map((recipientId) => ({
      recipientId,
      type: 'reply' as const,
      actorId,
      topicId,
      postId,
      createdAt: now,
    })),
  );
}

/** Writes one mention notification per mentioned user, excluding the actor. */
export async function notifyMentions(
  db: D1Database,
  args: { mentionUserIds: string[]; topicId: string; postId: string | null; actorId: string; now: number },
): Promise<void> {
  const { mentionUserIds, topicId, postId, actorId, now } = args;
  const recipients = [...new Set(mentionUserIds)].filter((id) => id !== actorId);
  await insertNotifications(
    db,
    recipients.map((recipientId) => ({
      recipientId,
      type: 'mention' as const,
      actorId,
      topicId,
      postId,
      createdAt: now,
    })),
  );
}
