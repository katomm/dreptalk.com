/// <reference types="@cloudflare/workers-types" />
// Test-only: brackets a write with two database clock reads, so a test can
// assert a timestamp came from the D1 clock without knowing its exact value.
import { readDbNow } from '../sql.js';

export async function withDbClock<T>(db: D1Database, write: () => Promise<T>): Promise<{ result: T; lo: number; hi: number }> {
  const lo = await readDbNow(db);
  const result = await write();
  const hi = await readDbNow(db);
  return { result, lo, hi };
}

/** Waits until the database clock has advanced past `ms`, so two writes cannot share a millisecond. */
export async function afterDbMs(db: D1Database, ms: number): Promise<void> {
  while ((await readDbNow(db)) <= ms) await new Promise((r) => setTimeout(r, 1));
}
