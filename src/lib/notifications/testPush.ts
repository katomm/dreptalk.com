/// <reference types="@cloudflare/workers-types" />
// Self-service test push: sends one real notification through the full web
// push pipeline to a single device the user owns, after a short delay that
// gives them time to lock the screen or switch away (a foregrounded app often
// shows no banner). Runs in the app worker's waitUntil after the API route
// has responded, so the delay is bounded by the runtime's post-response
// budget; keep TEST_PUSH_DELAY_MS well under 30 seconds.

import { listChannels, deleteChannelById } from '../db/notificationChannels.js';
import { isSubscriptionDead } from '../push/webPush.js';
import type { sendWebPush, PushSubscriptionTarget, VapidConfig } from '../push/webPush.js';

export const TEST_PUSH_DELAY_MS = 20_000;

export interface TestPushDeps {
  send: typeof sendWebPush;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Sends the delayed test notification to one of the user's own devices.
 * Returns what happened; the API route has already responded by the time this
 * resolves, so the result is for logging and tests. A dead subscription
 * (gone, or bound to another VAPID key) is pruned like the dispatcher does.
 */
export async function sendTestPush(
  db: D1Database,
  vapid: VapidConfig,
  args: { userId: string; channelId: string },
  deps: TestPushDeps,
): Promise<'sent' | 'not_found' | 'pruned' | 'failed'> {
  const channel = (await listChannels(db, args.userId)).find(
    (row) => row.id === args.channelId && row.channel === 'webpush',
  );
  if (!channel) return 'not_found';

  await deps.sleep(TEST_PUSH_DELAY_MS);

  const target = JSON.parse(channel.target) as PushSubscriptionTarget;
  const payload = JSON.stringify({
    title: 'DRepTalk test notification',
    body: 'Push is working on this device.',
    url: '/notifications/',
  });

  const result = await deps.send(target, payload, vapid);
  if (result.ok) return 'sent';
  if (isSubscriptionDead(result.status)) {
    await deleteChannelById(db, channel.id);
    return 'pruned';
  }
  return 'failed';
}
