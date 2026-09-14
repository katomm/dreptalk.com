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

/** The update's message or edited message when it is in the given chat, else null. */
function messageInChat(update: unknown, chatId: string): { message: Record<string, unknown>; edited: boolean } | null {
  if (typeof update !== 'object' || update === null) return null;
  const u = update as { message?: unknown; edited_message?: unknown };
  const edited = u.message === undefined;
  const message = edited ? u.edited_message : u.message;
  if (typeof message !== 'object' || message === null) return null;
  const chat = (message as { chat?: unknown }).chat;
  if (typeof chat !== 'object' || chat === null) return null;
  const id = (chat as { id?: unknown }).id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  return String(id) === chatId ? { message: message as Record<string, unknown>, edited } : null;
}

/**
 * Applies the guard to one update. Anything outside the configured group, or
 * from an account that is not under watch, is ignored; joins open a watch with
 * a fixed expiry; a watched account's message is judged, deleted when
 * suspicious, and the account banned once it reaches the strike limit. The
 * counters are bumped with single UPDATE statements, so two messages arriving
 * at once cannot lose a strike. Never throws on bad input.
 */
export async function handleGroupUpdate(
  db: D1Database,
  update: unknown,
  target: GroupGuardTarget,
  deps: GroupGuardDeps,
  now: number,
): Promise<GroupGuardOutcome> {
  const hit = messageInChat(update, target.chatId);
  if (!hit) return 'ignored';
  const { message, edited } = hit;
  const chatId = target.chatId;

  const joined = message.new_chat_members;
  if (Array.isArray(joined)) {
    const expiresAt = now + target.cfg.watchHours * 3_600_000;
    // A rejoin starts a fresh watch; expired rows are swept while we are here.
    const stmts = [db.prepare('DELETE FROM telegram_group_watch WHERE expires_at <= ?').bind(now)];
    for (const member of joined) {
      if (typeof member !== 'object' || member === null) continue;
      const { id, is_bot: isBot } = member as { id?: unknown; is_bot?: unknown };
      // A bot in the list was added by an admin on purpose, not a newcomer.
      if (typeof id !== 'number' || isBot === true) continue;
      stmts.push(
        db
          .prepare(
            `INSERT INTO telegram_group_watch (chat_id, user_id, expires_at, clean, strikes) VALUES (?, ?, ?, 0, 0)
             ON CONFLICT (chat_id, user_id) DO UPDATE SET expires_at = excluded.expires_at, clean = 0, strikes = 0`,
          )
          .bind(chatId, id, expiresAt),
      );
    }
    await db.batch(stmts);
    return stmts.length > 1 ? 'joined' : 'ignored';
  }

  const from = message.from;
  const userId = typeof from === 'object' && from !== null ? (from as { id?: unknown }).id : undefined;
  const messageId = message.message_id;
  if (typeof userId !== 'number' || typeof messageId !== 'number') return 'ignored';

  if (!isSuspiciousMessage(message, target.botUsername, target.cfg.patterns)) {
    // Edits of an existing message are judged but do not count towards release,
    // otherwise one message plus two harmless edits would end the watch.
    if (edited) return 'ignored';
    const row = await db
      .prepare(
        `UPDATE telegram_group_watch SET clean = clean + 1
         WHERE chat_id = ? AND user_id = ? AND expires_at > ? RETURNING clean`,
      )
      .bind(chatId, userId, now)
      .first<{ clean: number }>();
    if (!row) return 'ignored';
    if (row.clean >= target.cfg.cleanMessages) {
      await db.prepare('DELETE FROM telegram_group_watch WHERE chat_id = ? AND user_id = ?').bind(chatId, userId).run();
    }
    return 'clean';
  }

  const row = await db
    .prepare(
      `UPDATE telegram_group_watch SET strikes = strikes + 1
       WHERE chat_id = ? AND user_id = ? AND expires_at > ? RETURNING strikes`,
    )
    .bind(chatId, userId, now)
    .first<{ strikes: number }>();
  if (!row) return 'ignored';

  const banning = row.strikes >= target.cfg.strikesToBan;
  const [del, ban] = await Promise.all([
    deps.deleteMessage(chatId, messageId),
    banning ? deps.banChatMember(chatId, userId) : null,
  ]);
  if (!del.ok) console.warn(`[telegram-guard] delete failed status=${del.status} ${del.description}`);
  if (!ban) return 'deleted';
  if (!ban.ok) {
    // The watch stays, so the next message is judged again and the ban retried.
    console.warn(`[telegram-guard] ban failed status=${ban.status} ${ban.description}`);
    return 'deleted';
  }
  await db.prepare('DELETE FROM telegram_group_watch WHERE chat_id = ? AND user_id = ?').bind(chatId, userId).run();
  console.log(`[telegram-guard] banned user=${userId} after ${row.strikes} strikes`);
  return 'banned';
}
