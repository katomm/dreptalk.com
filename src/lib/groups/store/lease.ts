/// <reference types="@cloudflare/workers-types" />
// The lease that serializes DRep groups runs. Expiry is read from the database clock, and every
// write batch is guarded by an insert whose CHECK fails unless the token still holds a live lease.
import { LeaseLostError } from 'drep-groups';
import { Q } from './queries.js';

/** A fresh owner per invocation, so a run never takes over a lease it did not acquire. */
export function invocationOwner(): string {
  return `gov-sync:${crypto.randomUUID()}`;
}

/**
 * Takes the lease when no row exists, the current one has expired, or the live one belongs to
 * the same owner (a renewal with a new token, the old token stops working). Null otherwise.
 */
export async function acquireLease(db: D1Database, owner: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const res = await db.batch<{ token: string | null }>([
    db.prepare(Q.leaseSeed.sql),
    db.prepare(Q.leaseTake.sql).bind(owner, token, owner),
    db.prepare(Q.leaseToken.sql),
  ]);
  return res[2].results?.[0]?.token === token ? token : null;
}

/** Ends the lease, only while the token still holds it. */
export async function releaseLease(db: D1Database, token: string): Promise<void> {
  await db.prepare(Q.leaseRelease.sql).bind(token).run();
}

/** First statement of every write batch. */
export function leaseGuard(db: D1Database, token: string): D1PreparedStatement {
  return db.prepare(Q.leaseGuard.sql).bind(token);
}

/** Last statement of every write batch. */
export function leaseGuardEnd(db: D1Database): D1PreparedStatement {
  return db.prepare(Q.leaseGuardEnd.sql);
}

/** True when the error is the lease guard's CHECK, any other failure stays an error. */
export function isLeaseFailure(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/CHECK constraint failed: lease_ok\b/.test(e.message)) return true;
  }
  return false;
}

/** Runs the statements between the guard and its end in one batch. A lost lease rejects with LeaseLostError. */
export async function writeBatch(db: D1Database, token: string, stmts: D1PreparedStatement[]): Promise<void> {
  await guardedBatch(db, token, stmts);
}

/** writeBatch that returns every result, the guard's included. */
export async function guardedBatch(db: D1Database, token: string, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await db.batch([leaseGuard(db, token), ...stmts, leaseGuardEnd(db)]);
  } catch (err) {
    if (isLeaseFailure(err)) throw new LeaseLostError('lease lost', { cause: err });
    throw err;
  }
}
