/// <reference types="@cloudflare/workers-types" />
// Generic key/value access for the app_meta table. Values are opaque strings;
// callers JSON-encode structured data. Parameterized; never interpolated SQL.

export interface AppMetaRow {
  value: string;
  updatedAt: number;
}

/** Reads one app_meta value by key, or null if absent. */
export async function getAppMeta(db: D1Database, key: string): Promise<AppMetaRow | null> {
  const row = await db
    .prepare('SELECT value, updated_at FROM app_meta WHERE key = ?')
    .bind(key)
    .first<{ value: string; updated_at: number }>();
  return row ? { value: row.value, updatedAt: row.updated_at } : null;
}

/** Inserts or replaces one app_meta value. */
export async function setAppMeta(db: D1Database, key: string, value: string, updatedAt: number): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(key, value, updatedAt)
    .run();
}
