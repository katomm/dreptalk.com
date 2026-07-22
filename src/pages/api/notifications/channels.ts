// GET /api/notifications/channels: lists the signed-in user's connected
// channels, optionally filtered to one kind via ?channel=webpush|telegram.
// POST connects a new push channel (currently only 'webpush' subscriptions;
// telegram rows are created by the webhook). DELETE removes one, scoped to
// its owner via addChannel/removeChannel.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { addChannel, removeChannel, listChannels } from '@/lib/db/notificationChannels';
import { toClientChannels } from '@/lib/notifications/channelView';

export const prerender = false;

// Per-field length caps bound what gets stored (endpoint plus two short
// base64url keys); real subscriptions are far below these, anything above is
// abuse. This keeps parsing on the same plain request.json() pattern every
// other API route uses.
const subscriptionSchema = z.object({
  endpoint: z.string().startsWith('https://').max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

const postSchema = z.object({
  channel: z.literal('webpush'),
  subscription: subscriptionSchema,
});

const deleteSchema = z.object({
  id: z.string().min(1).max(64),
});

const channelKindSchema = z.enum(['webpush', 'telegram']);

async function readJson(request: Request): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false };
  }
}

// GET: the signed-in user's connected channels, optionally narrowed to one
// kind via ?channel=webpush|telegram. The settings islands use this both for
// polling (e.g. while a Telegram link is pending) and for this-device
// matching (webpush only, by endpoint fingerprint); the Telegram card passes
// the filter so a poll never pays webpush fingerprint hashing for rows it
// will discard anyway. Returns only safe fields, never the stored
// subscription or chat id.
export const GET: APIRoute = async ({ locals, url }) => {
  const user = (locals as App.Locals).user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
  const channelParam = url.searchParams.get('channel');
  const kind = channelParam === null ? undefined : channelKindSchema.safeParse(channelParam);
  if (kind && !kind.success) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }
  let rows = await listChannels(db, user.id);
  if (kind) rows = rows.filter((r) => r.channel === kind.data);
  const channels = await toClientChannels(rows);
  return jsonResponse({ ok: true, channels });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }

  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }
  const parsed = postSchema.safeParse(body.data);
  if (!parsed.success) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }

  // Store only the fields sendWebPush actually reads, not whatever extra
  // properties the browser's PushSubscriptionJSON happens to include.
  const target = JSON.stringify({
    endpoint: parsed.data.subscription.endpoint,
    keys: parsed.data.subscription.keys,
  });
  const id = await addChannel(db, {
    userId: user.id,
    channel: 'webpush',
    target,
    endpoint: parsed.data.subscription.endpoint,
    now: Date.now(),
  });
  return jsonResponse({ ok: true, id }, 201);
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }

  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }
  const parsed = deleteSchema.safeParse(body.data);
  if (!parsed.success) {
    return jsonResponse({ ok: false, error: 'invalid input' }, 400);
  }

  await removeChannel(db, user.id, parsed.data.id);
  return jsonResponse({ ok: true });
};
