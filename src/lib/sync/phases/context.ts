/// <reference types="@cloudflare/workers-types" />
// Shared core of the per-kind sync contexts. Each registry extends this with
// exactly the fields its phases need (gates, optional bindings, run state), so
// no context accumulates optional fields for phases of another cron kind. The
// worker entry builds the context; phase modules never see the raw env.

import type { NetworkConfig } from '../../config/network.js';
import type { createKoiosClient } from '../../koios/client.js';

export type GovSyncKoios = ReturnType<typeof createKoiosClient>;

export interface CoreSyncContext {
  db: D1Database;
  koios: GovSyncKoios;
  cfg: NetworkConfig;
  /** Run start in unix ms. Phases needing a fresh timestamp call Date.now() themselves. */
  now: number;
}
