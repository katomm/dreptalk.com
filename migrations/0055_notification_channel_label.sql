-- Optional human-readable label for a channel row. Telegram: the chat's
-- @username or first name, captured at /start time. Webpush rows stay NULL.
ALTER TABLE notification_channels ADD COLUMN label TEXT;
