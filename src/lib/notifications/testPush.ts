/// <reference types="@cloudflare/workers-types" />
// Self-service test send: sends one real notification through the full
// delivery pipeline to a single channel the user owns. For web push, after a
// short delay that gives them time to lock the screen or switch away (a
// foregrounded app often shows no banner); for telegram, immediately, since
// a Telegram message needs no locked screen to be visible. The web push send
// runs in the app worker's waitUntil after the API route has responded, so
// the delay is bounded by the runtime's post-response budget; keep
// TEST_PUSH_DELAY_MS well under 30 seconds.

import { listChannels, deleteChannelById } from '../db/notificationChannels.js';
import { isSubscriptionDead } from '../push/webPush.js';
import type { sendWebPush, PushSubscriptionTarget, VapidConfig } from '../push/webPush.js';
import { isTelegramChatDead } from '../push/telegram.js';
import type { sendTelegramMessage } from '../push/telegram.js';

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

/**
 * Sends an immediate test message to one of the user's own telegram channels.
 * No delay: unlike push, a Telegram message needs no locked screen to be
 * visible. Dead chats are pruned like the dispatcher does.
 */
export async function sendTestTelegram(
  db: D1Database,
  botToken: string,
  args: { userId: string; channelId: string },
  deps: { send: typeof sendTelegramMessage },
): Promise<'sent' | 'not_found' | 'pruned' | 'failed'> {
  const channel = (await listChannels(db, args.userId)).find(
    (row) => row.id === args.channelId && row.channel === 'telegram',
  );
  if (!channel) return 'not_found';

  const result = await deps.send(botToken, channel.target, 'DRepTalk test notification: Telegram is connected and working.');
  if (result.ok) return 'sent';
  if (isTelegramChatDead(result)) {
    await deleteChannelById(db, channel.id);
    return 'pruned';
  }
  return 'failed';
}
