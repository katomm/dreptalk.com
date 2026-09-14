/// <reference types="@cloudflare/workers-types" />
// Anti-spam guard for the one public group the bot is an admin of. Accounts
// that just joined are watched for a while: a message with a link, mention,
// forward or inline keyboard is deleted, and a repeat offender is banned. The
// mechanics live here; the thresholds and any extra text patterns come from
// the TELEGRAM_GROUP_GUARD secret (JSON), so the deployed values are not part
// of the public repository. The defaults below are deliberately mild.

export interface GroupGuardConfig {
  /** How long after joining an account stays under watch. */
  watchHours: number;
  /** Unflagged messages after which the watch ends early. */
  cleanMessages: number;
  /** Flagged messages within the watch window that trigger a ban. */
  strikesToBan: number;
  /** Extra patterns that count as suspicious text, compiled once at parse time. */
  patterns: RegExp[];
}

export const GROUP_GUARD_DEFAULTS: GroupGuardConfig = Object.freeze({
  watchHours: 24,
  cleanMessages: 3,
  strikesToBan: 2,
  patterns: [],
});

/**
 * Parses the JSON guard config. Fields that are missing keep their default; a
 * field of the wrong type (or a non-positive count) invalidates the whole value
 * and the defaults apply with a warning, because a half-read config is harder
 * to reason about than an obviously ignored one. Invalid regex sources are
 * dropped individually.
 */
export function parseGroupGuardConfig(raw: string | undefined): GroupGuardConfig {
  if (!raw) return GROUP_GUARD_DEFAULTS;
  const rejected = (why: string): GroupGuardConfig => {
    console.warn(`[telegram-guard] TELEGRAM_GROUP_GUARD ignored (${why}), defaults apply`);
    return GROUP_GUARD_DEFAULTS;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rejected('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return rejected('not an object');
  const obj = parsed as Record<string, unknown>;
  const cfg: GroupGuardConfig = { ...GROUP_GUARD_DEFAULTS };
  for (const key of ['watchHours', 'cleanMessages', 'strikesToBan'] as const) {
    const n = obj[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return rejected(`${key} not a positive number`);
    cfg[key] = n;
  }
  if (obj.patterns !== undefined) {
    if (!Array.isArray(obj.patterns) || !obj.patterns.every((p) => typeof p === 'string')) {
      return rejected('patterns not a string array');
    }
    cfg.patterns = [];
    for (const source of obj.patterns as string[]) {
      try {
        cfg.patterns.push(new RegExp(source, 'i'));
      } catch {
        console.warn('[telegram-guard] invalid pattern skipped');
      }
    }
  }
  return cfg;
}

const LINK_ENTITY_TYPES = new Set(['url', 'text_link', 'mention', 'text_mention']);

// Telegram marks most links as entities, but a bare "t.me/..." or a scheme
// pasted mid-word can slip through, so the raw text is checked as well.
const RAW_LINK = /(?:https?:\/\/|www\.|\bt\.me\/|\btelegram\.me\/)/i;

/**
 * True when a group message looks like the first move of a spam account: any
 * link or mention entity (except a mention of the bot itself), a forward, an
 * inline keyboard, a raw link in the text, or one of the configured patterns.
 */
export function isSuspiciousMessage(message: unknown, botUsername: string, patterns: RegExp[]): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  if (msg.forward_origin !== undefined || msg.forward_from !== undefined || msg.forward_from_chat !== undefined) {
    return true;
  }
  if (typeof msg.reply_markup === 'object' && msg.reply_markup !== null) return true;

  const self = `@${botUsername}`.toLowerCase();
  for (const [textKey, entitiesKey] of [
    ['text', 'entities'],
    ['caption', 'caption_entities'],
  ] as const) {
    const text = typeof msg[textKey] === 'string' ? (msg[textKey] as string) : '';
    const entities = Array.isArray(msg[entitiesKey]) ? (msg[entitiesKey] as unknown[]) : [];
    for (const raw of entities) {
      const e = raw as { type?: unknown; offset?: unknown; length?: unknown };
      if (typeof e.type !== 'string' || !LINK_ENTITY_TYPES.has(e.type)) continue;
      // Telegram offsets count UTF-16 code units, the same as JS string indices.
      if (
        e.type === 'mention' &&
        typeof e.offset === 'number' &&
        typeof e.length === 'number' &&
        text.slice(e.offset, e.offset + e.length).toLowerCase() === self
      ) {
        continue;
      }
      return true;
    }
    if (text !== '' && (RAW_LINK.test(text) || patterns.some((p) => p.test(text)))) return true;
  }
  return false;
}

export interface GroupGuardTarget {
  /** The one chat id (as Telegram sends it, e.g. "-1001234") the guard acts in. */
  chatId: string;
  botUsername: string;
  cfg: GroupGuardConfig;
}

export interface GroupGuardDeps {
  deleteMessage: (chatId: string, messageId: number) => Promise<{ ok: boolean; status: number; description: string }>;
  banChatMember: (chatId: string, userId: number) => Promise<{ ok: boolean; status: number; description: string }>;
}

/** 'ignored' covers everything outside the group or from an account not under watch. */
export type GroupGuardOutcome = 'joined' | 'clean' | 'deleted' | 'banned' | 'ignored';

interface Watch {
  clean: number;
  strikes: number;
}

const watchKey = (chatId: string, userId: number) => `tg:newcomer:${chatId}:${userId}`;

/** The update's message or edited message when it is in the given chat, else null. */
function messageInChat(update: unknown, chatId: string): Record<string, unknown> | null {
  if (typeof update !== 'object' || update === null) return null;
  const u = update as { message?: unknown; edited_message?: unknown };
  const message = u.message ?? u.edited_message;
  if (typeof message !== 'object' || message === null) return null;
  const chat = (message as { chat?: unknown }).chat;
  if (typeof chat !== 'object' || chat === null) return null;
  const id = (chat as { id?: unknown }).id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  return String(id) === chatId ? (message as Record<string, unknown>) : null;
}

/**
 * Applies the guard to one update. Anything outside the configured group, or
 * from an account that was never seen joining, is ignored; joins open a watch
 * (the watch window is the KV entry's TTL); a watched account's message is
 * judged, deleted when suspicious, and the account banned once it reaches the
 * strike limit. Never throws on bad input.
 */
export async function handleGroupUpdate(
  kv: KVNamespace,
  update: unknown,
  target: GroupGuardTarget,
  deps: GroupGuardDeps,
): Promise<GroupGuardOutcome> {
  const message = messageInChat(update, target.chatId);
  if (!message) return 'ignored';
  const ttl = Math.max(60, Math.round(target.cfg.watchHours * 3600));
  const put = (key: string, watch: Watch) => kv.put(key, JSON.stringify(watch), { expirationTtl: ttl });

  const joined = message.new_chat_members;
  if (Array.isArray(joined)) {
    const opened: Promise<void>[] = [];
    for (const member of joined) {
      if (typeof member !== 'object' || member === null) continue;
      const { id, is_bot: isBot } = member as { id?: unknown; is_bot?: unknown };
      // A bot in the list was added by an admin on purpose, not a newcomer.
      if (typeof id !== 'number' || isBot === true) continue;
      opened.push(put(watchKey(target.chatId, id), { clean: 0, strikes: 0 }));
    }
    await Promise.all(opened);
    return opened.length > 0 ? 'joined' : 'ignored';
  }

  const from = message.from;
  const userId = typeof from === 'object' && from !== null ? (from as { id?: unknown }).id : undefined;
  const messageId = message.message_id;
  if (typeof userId !== 'number' || typeof messageId !== 'number') return 'ignored';

  const key = watchKey(target.chatId, userId);
  const watch = await kv.get<Watch>(key, 'json');
  if (!watch) return 'ignored';

  if (!isSuspiciousMessage(message, target.botUsername, target.cfg.patterns)) {
    watch.clean++;
    await (watch.clean >= target.cfg.cleanMessages ? kv.delete(key) : put(key, watch));
    return 'clean';
  }

  watch.strikes++;
  const banning = watch.strikes >= target.cfg.strikesToBan;
  // The Telegram calls and the KV bookkeeping are independent, so they overlap.
  const [del, ban] = await Promise.all([
    deps.deleteMessage(target.chatId, messageId),
    banning ? deps.banChatMember(target.chatId, userId) : null,
    banning ? kv.delete(key) : put(key, watch),
  ]);
  if (!del.ok) console.warn(`[telegram-guard] delete failed status=${del.status} ${del.description}`);
  if (ban && !ban.ok) console.warn(`[telegram-guard] ban failed status=${ban.status} ${ban.description}`);
  if (banning) console.log(`[telegram-guard] banned user=${userId} after ${watch.strikes} strikes`);
  return banning ? 'banned' : 'deleted';
}
