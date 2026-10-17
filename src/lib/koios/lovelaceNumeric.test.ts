import { describe, it, expect } from 'vitest';
import { createKoiosClient } from './client';
import * as fx from './lovelaceNumeric.fixtures';

type KoiosClient = ReturnType<typeof createKoiosClient>;

// Koios v1.5 sends lovelace as JSON numbers. Every lovelace field the client
// declares must read the same from either form, and an amount above 2^53
// must stay exact. Bodies stay raw text end to end: a JS number literal above
// 2^53 would already be rounded before the client saw it.

function clientFor(body: string): KoiosClient {
  return createKoiosClient({
    baseUrl: 'https://koios.test/api/v1',
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
}

// Unquotes the decimal-string value of each named key, which is how Koios
// v1.5 serves the same row. Undeclared (passthrough) fields keep their quotes,
// so both runs see them alike and only the declared fields are under test.
function numeric(text: string, keys: readonly string[]): string {
  const pattern = new RegExp(`"(${keys.join('|')})":"(\\d+)"`, 'g');
  const out = text.replace(pattern, '"$1":$2');
  if (out === text) throw new Error(`fixture has none of ${keys.join(', ')}`);
  return out;
}

const VOTE_POWER_KEYS = [
  'drep_active_yes_vote_power',
  'drep_active_no_vote_power',
  'drep_active_abstain_vote_power',
  'drep_no_vote_power',
  'drep_always_abstain_vote_power',
  'drep_always_no_confidence_vote_power',
  'pool_active_yes_vote_power',
  'pool_active_no_vote_power',
  'pool_active_abstain_vote_power',
  'pool_no_vote_power',
  'pool_passive_always_abstain_vote_power',
  'pool_passive_always_no_confidence_vote_power',
];

const cases: Array<{ name: string; body: string; keys: string[]; read: (c: KoiosClient) => Promise<unknown> }> = [
  // The single-row drepInfo used at login declares no amount, the batch one does.
  { name: 'drep_info', body: fx.DREP_INFO, keys: ['deposit'], read: (c) => c.drepInfo('drep1') },
  { name: 'drep_info batch', body: fx.DREP_INFO, keys: ['deposit', 'amount'], read: (c) => c.drepInfoBatch(['drep1']) },
  { name: 'account_info', body: fx.ACCOUNT_INFO, keys: ['total_balance'], read: (c) => c.accountInfo('stake1') },
  { name: 'proposal_list', body: fx.PROPOSAL_LIST, keys: ['deposit'], read: (c) => c.proposalList(1) },
  {
    name: 'proposal_voting_summary',
    body: fx.PROPOSAL_VOTING_SUMMARY,
    keys: VOTE_POWER_KEYS,
    read: (c) => c.proposalVotingSummary('gov_action1'),
  },
  { name: 'pool_info', body: fx.POOL_INFO, keys: ['active_stake'], read: (c) => c.poolInfoBatch(['pool1']) },
  {
    name: 'drep_voting_power_history',
    body: fx.DREP_VOTING_POWER_HISTORY,
    keys: ['amount'],
    read: (c) => c.drepVotingPowerHistory(660),
  },
  { name: 'drep_delegators', body: fx.DREP_DELEGATORS, keys: ['amount'], read: (c) => c.drepDelegators('drep1') },
  {
    name: 'totals',
    body: fx.TOTALS,
    keys: ['treasury', 'reserves', 'circulation', 'supply'],
    read: (c) => c.totals(660),
  },
  { name: 'pool_list', body: fx.POOL_LIST, keys: ['active_stake', 'pledge', 'fixed_cost'], read: (c) => c.poolList() },
];

describe('Koios lovelace as JSON numbers (v1.5)', () => {
  it.each(cases)('$name reads the same from strings and from numbers', async ({ body, keys, read }) => {
    const fromStrings = await read(clientFor(body));
    const fromNumbers = await read(clientFor(numeric(body, keys)));
    expect(fromStrings).not.toBeNull();
    expect(fromNumbers).toEqual(fromStrings);
  });

  it('reads the pool list Koios serves with its numeric preview flag like the string one', async () => {
    const fromStrings = await clientFor(fx.POOL_LIST).poolList();
    const fromNumbers = await clientFor(fx.POOL_LIST_NUMERIC).poolList();
    expect(fromNumbers).toEqual(fromStrings);
  });

  it('keeps a circulation above 2^53 exact', async () => {
    const body = numeric(fx.TOTALS, ['circulation', 'supply']);
    const totals = await clientFor(body).totals(660);
    const raw = JSON.parse(fx.TOTALS)[0] as { circulation: string; supply: string };
    expect(BigInt(raw.circulation)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(totals?.circulationLovelace).toBe(raw.circulation);
    expect(totals?.supplyLovelace).toBe(raw.supply);
  });

  it('refuses a lovelace amount that is not a whole non-negative number', async () => {
    for (const bad of ['-1', '1.5', '"12a"']) {
      const body = fx.TOTALS.replace(/"treasury":"\d+"/, `"treasury":${bad}`);
      await expect(clientFor(body).totals(660)).rejects.toThrow();
    }
  });
});
