/// <reference types="@cloudflare/workers-types" />
// Every SQL text the DRep groups store, jobs and page readers run, by name, so one check
// can inspect how SQLite executes each of them.
import { DB_NOW_MS } from '../../db/sql.js';
import { LEASE_MS } from '../constants.js';

export interface RegisteredQuery {
  sql: string;
  /** The index a keyset read with ORDER BY and LIMIT may scan. */
  boundedScan?: string;
}

const LIVE_LEASE = `id = 1 AND token = ? AND expires_at > ${DB_NOW_MS}`;

export const Q = Object.freeze({
  leaseSeed: {
    sql: 'INSERT OR IGNORE INTO drep_group_lease (id, owner, token, expires_at) VALUES (1, NULL, NULL, 0)',
  },
  // Binds owner, token, owner. Takes an expired lease, or renews a live one of the same owner.
  leaseTake: {
    sql: `UPDATE drep_group_lease SET owner = ?, token = ?, expires_at = ${DB_NOW_MS} + ${LEASE_MS}
          WHERE id = 1 AND (expires_at <= ${DB_NOW_MS} OR owner = ?)`,
  },
  leaseToken: { sql: 'SELECT token FROM drep_group_lease WHERE id = 1' },
  leaseRelease: { sql: 'UPDATE drep_group_lease SET expires_at = 0 WHERE id = 1 AND token = ?' },
  leaseGuard: {
    sql: `INSERT INTO drep_group_lease_check (ok)
          SELECT CASE WHEN EXISTS (SELECT 1 FROM drep_group_lease WHERE ${LIVE_LEASE}) THEN 1 ELSE 0 END`,
  },
  leaseGuardEnd: { sql: 'DELETE FROM drep_group_lease_check' },
} satisfies Record<string, RegisteredQuery>);

/** Sample binds per query, placeholders only, for the query plan check. */
export const Q_SAMPLE_BINDS: Readonly<Record<keyof typeof Q, unknown[]>> = Object.freeze({
  leaseSeed: [],
  leaseTake: ['owner', 'token', 'owner'],
  leaseToken: [],
  leaseRelease: ['token'],
  leaseGuard: ['token'],
  leaseGuardEnd: [],
});
