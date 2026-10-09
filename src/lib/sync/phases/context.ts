/// <reference types="@cloudflare/workers-types" />
// Shared core of the per-kind sync contexts. Each registry extends this with
// exactly the fields its phases need (gates, optional bindings, run state), so
// no context accumulates optional fields for phases of another cron kind. The
// worker entry builds the context; phase modules never see the raw env.

import type { NetworkConfig } from '../../config/network.js';
import type { createKoiosClient } from '../../koios/client.js';
import type { DedicatedGateway } from '../../governance/metadata.js';

export type GovSyncKoios = ReturnType<typeof createKoiosClient>;

export interface CoreSyncContext {
  db: D1Database;
  koios: GovSyncKoios;
  cfg: NetworkConfig;
  /** Run start in unix ms. Phases needing a fresh timestamp call Date.now() themselves. */
  now: number;
  /**
   * Dedicated IPFS gateway for anchor reads, from the PINATA_GATEWAY_* secrets.
   * On the core because the governance, vote and DRep phases all read anchors.
   * Null or absent means the public gateway list alone.
   */
  gateway?: DedicatedGateway | null;
}
