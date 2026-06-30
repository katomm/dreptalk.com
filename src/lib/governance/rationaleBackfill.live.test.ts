// LIVE mainnet e2e (gated). Skipped unless DREPTALK_LIVE=1, because it needs
// outbound network to mainnet Koios and to a DRep's rationale host. Runs in the
// Node test project (the Workers test pool cannot reach the network). It proves
// the two real I/O halves of the rationale backfill against the real, already
// finalized Tweag Core Cardano Infrastructure treasury action:
//   1. Koios returns a real meta_hash for the action's anchored votes (the value
//      the backfill phase writes; missing on votes synced before hash capture).
//   2. The on-chain rationale document still fetches and verifies against that
//      hash (what the ingestion phase renders for the Positions tab).
// The D1 storage and self-drain logic between them is covered deterministically
// in tallySync.workers.test.ts. Nothing is written to production here.
//
// Run it with:
//   DREPTALK_LIVE=1 npx vitest run src/lib/governance/rationaleBackfill.live.test.ts
import { describe, it, expect } from 'vitest';
import { createKoiosClient } from '../koios/client.js';
import { resolveNetwork } from '../config/network.js';
import { fetchVoteRationale } from './voteRationaleAnchor.js';

const LIVE = process.env.DREPTALK_LIVE === '1';

const PROPOSAL_ID = 'gov_action1zljrlljt9cxlz7ra2nep43nxg0r54wcnrgexyuhuam9ah0ws607qq2vcg4x';
// Highest-power anchored voter on this action (YoroiDRep, ~595M ADA), Yes.
const VOTER_ID = 'drep1ygr9tuapcanc3kpeyy4dc3vmrz9cfe5q7v9wj3x9j0ap3tswtre9j';

describe.skipIf(!LIVE)('rationale backfill data path against the real Tweag action (live mainnet)', () => {
  it('Koios returns real meta_hashes and the on-chain rationale verifies against one', async () => {
    const koios = createKoiosClient({
      baseUrl: resolveNetwork('mainnet').koiosBaseUrl,
      timeoutMs: 25_000,
      retries: 2,
      retryDelayMs: 500,
    });

    // Phase 1 source: the real per-vote rows the backfill re-fetches.
    const votes = await koios.proposalVotes(PROPOSAL_ID);
    const anchored = votes.filter((v) => v.meta_url && v.meta_hash);
    const hashed = anchored.filter((v) => /^[0-9a-f]{64}$/.test(v.meta_hash ?? ''));
    console.log(`[live] total votes=${votes.length} anchored=${anchored.length} with valid hash=${hashed.length}`);

    // The exact gap the backfill repairs: these hashes exist on-chain and Koios
    // serves them, but pre-capture rows stored them as NULL.
    expect(anchored.length).toBeGreaterThan(50);
    expect(hashed.length).toBe(anchored.length);

    const yoroi = anchored.find((v) => v.voter_id === VOTER_ID);
    expect(yoroi, 'YoroiDRep vote present in the live response').toBeTruthy();
    console.log(`[live] YoroiDRep hash=${yoroi?.meta_hash} url=${yoroi?.meta_url}`);

    // Phase 2: the ingestion fetch the cron runs once the hash is present. It
    // pulls the real document and verifies it against the on-chain hash; a
    // tampered or unreachable doc would return 'failed'.
    const rationale = await fetchVoteRationale(yoroi?.meta_url ?? '', yoroi?.meta_hash ?? '');
    console.log(`[live] YoroiDRep rationale fetch status=${rationale.status}`);
    expect(rationale.status).toBe('ok');
    if (rationale.status === 'ok') {
      expect(rationale.bodyHtml && rationale.bodyHtml.length > 0).toBe(true);
      console.log(`[live] rationale body length=${rationale.bodyHtml?.length ?? 0}`);
    }
  }, 120_000);
});
