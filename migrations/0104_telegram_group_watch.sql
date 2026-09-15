-- Accounts newly joined to the moderated Telegram group, watched by the
-- anti-spam guard (src/lib/notifications/telegramGroupGuard.ts). One row per
-- chat and Telegram user, opened on join with a fixed expiry, counted up
-- atomically per message, removed once the account is cleared or banned.
-- Expired rows are swept lazily on the next join.
CREATE TABLE telegram_group_watch (
  chat_id    TEXT    NOT NULL,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- ms epoch, watch window end, fixed at join
  clean      INTEGER NOT NULL DEFAULT 0,
  strikes    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
