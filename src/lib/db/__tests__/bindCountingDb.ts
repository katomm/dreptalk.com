/// <reference types="@cloudflare/workers-types" />
// Test-only D1 wrapper that records the largest number of parameters any single
// prepared statement binds. Production D1 rejects a statement with more than
// 100 bound parameters, but local miniflare does not enforce the cap, so an
// overflowing IN (...) passes every test and 500s only in production. Wrapping
// the binding with this proxy lets a test assert maxBinds() <= 100 while the
// queries run unchanged against the real miniflare D1.

export function bindCountingDb(real: D1Database): { db: D1Database; maxBinds: () => number } {
  let max = 0;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(sTarget, sProp) {
              if (sProp === 'bind') {
                return (...args: unknown[]) => {
                  max = Math.max(max, args.length);
                  return sTarget.bind(...args);
                };
              }
              const value = Reflect.get(sTarget, sProp, sTarget);
              return typeof value === 'function' ? value.bind(sTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db, maxBinds: () => max };
}
