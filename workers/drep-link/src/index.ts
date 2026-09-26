// Worker entry for drep.link. All logic lives in src/lib/drepLink/worker.ts.
import { handleRequest } from '../../../src/lib/drepLink/worker.js';
import { resolveNetwork } from '../../../src/lib/config/network.js';

interface Env {
  DB: D1Database;
  CARDANO_NETWORK?: string;
}

export default {
  fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, {
      db: env.DB,
      cfg: resolveNetwork(env.CARDANO_NETWORK ?? null),
      now: Math.floor(Date.now() / 1000),
      cache: (caches as CacheStorage & { default: Cache }).default,
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
} satisfies ExportedHandler<Env>;
