// On-chain pool lookup for the search fallback: a pasted pool id that has no
// row in D1 belongs to a pool that never voted, and Koios tells whether the
// pool exists at all. Only identifiers.ts lets checksum-valid pool ids through,
// so random strings never reach Koios.
import { runtimeEnv, currentNetwork } from '../api/response.js';
import { createKoiosClient } from '../koios/client.js';
import { sanitizePoolIdentity } from '../pools/offchain.js';
import type { PoolLookup } from './handler.js';

// The palette waits on this answer, so a slow Koios must not stall it for the
// client's default 10 s. A timeout shows no notice, the search still answers.
const LOOKUP_TIMEOUT_MS = 3_000;

/** A PoolLookup backed by Koios /pool_info on the current network. */
export function koiosPoolLookup(locals?: App.Locals): PoolLookup {
  const env = runtimeEnv(locals);
  const koios = createKoiosClient({
    baseUrl: currentNetwork().koiosBaseUrl,
    token: (env.KOIOS_API_KEY as string | undefined) || undefined,
    timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  return async (poolId) => {
    const [row] = await koios.poolInfoBatch([poolId]);
    if (!row) return null;
    // Operator-written metadata, cleaned and capped like the pool sync does.
    const { ticker, name } = row.meta_json ? sanitizePoolIdentity(row.meta_json) : { ticker: null, name: null };
    return { ticker, name };
  };
}
