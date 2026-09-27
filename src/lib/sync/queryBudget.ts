/// <reference types="@cloudflare/workers-types" />

// Counts the D1 queries one cron invocation issues, so budgeted phases can stop
// before the per-invocation D1 query limit (1000 on Workers Paid) instead of
// failing mid-run. Statements are patched in place rather than proxied,
// db.batch needs the real statement objects, which a Proxy is not.
//
// A batch counts one query per statement. Whether D1 counts a batch as one
// query or as one per statement is not clearly documented, so this assumes the
// worse case.

export interface QueryMeter {
  used(): number;
}

const COUNTED = ['first', 'all', 'run', 'raw'] as const;

function instrument(stmt: D1PreparedStatement, tick: () => void): D1PreparedStatement {
  const s = stmt as unknown as Record<string, unknown>;
  for (const name of COUNTED) {
    const original = s[name] as (...args: unknown[]) => unknown;
    s[name] = (...args: unknown[]) => {
      tick();
      return original.apply(stmt, args);
    };
  }
  const bind = s.bind as (...args: unknown[]) => D1PreparedStatement;
  s.bind = (...args: unknown[]) => instrument(bind.apply(stmt, args), tick);
  return stmt;
}

export function countingDb(real: D1Database): { db: D1Database; meter: QueryMeter } {
  let n = 0;
  const tick = () => {
    n++;
  };
  const db = {
    prepare: (sql: string) => instrument(real.prepare(sql), tick),
    batch: <T = unknown>(stmts: D1PreparedStatement[]) => {
      n += stmts.length;
      return real.batch<T>(stmts);
    },
    exec: (sql: string) => {
      tick();
      return real.exec(sql);
    },
    dump: () => real.dump(),
    // Passed straight through to the real binding, so queries run on a session
    // from withSession are not counted. Dormant today: no budgeted caller uses
    // withSession, they all query the plain binding directly.
    withSession: (...args: Parameters<D1Database['withSession']>) => real.withSession(...args),
  } as unknown as D1Database;
  return { db, meter: { used: () => n } };
}

/** A phase's share of the invocation budget, measured from the moment it is created. */
export interface Allowance {
  spent(): number;
  remaining(): number;
  /** True when at least `cost` more queries fit. */
  covers(cost: number): boolean;
}

export function allowance(meter: QueryMeter, limit: number): Allowance {
  const start = meter.used();
  const spent = () => meter.used() - start;
  const remaining = () => limit - spent();
  return { spent, remaining, covers: (cost) => remaining() >= cost };
}

/** No limit, for callers outside a budgeted run (tests, one-off scripts). */
export const UNLIMITED: Allowance = { spent: () => 0, remaining: () => Number.POSITIVE_INFINITY, covers: () => true };
