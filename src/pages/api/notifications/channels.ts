// POST /api/notifications/channels: connects a new push channel for the
// signed-in user (currently only 'webpush' subscriptions). DELETE removes one,
// scoped to its owner via addChannel/removeChannel.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { addChannel, removeChannel } from '@/lib/db/notificationChannels';

export const prerender = false;

// Whole request body cap, well above a real PushSubscriptionJSON (endpoint plus
// two short base64url keys) but small enough to reject anything abusive.
const MAX_BODY_BYTES = 4 * 1024;

const subscriptionSchema = z.object({
  endpoint: z.string().startsWith('https://'),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const postSchema = z.object({
  channel: z.literal('webpush'),
  subscription: subscriptionSchema,
});

const deleteSchema = z.object({
  id: z.string().min(1),
});

async function readBoundedJson(request: Request): Promise<{ ok: true; data: unknown } | { ok: false }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }

  const body = await readBoundedJson(request);
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

  const body = await readBoundedJson(request);
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
