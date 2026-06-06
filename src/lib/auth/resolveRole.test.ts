import { describe, it, expect } from 'vitest';
import { resolveDRep, resolveProposer } from './resolveRole';
import type { DrepInfo, AccountInfo } from '../koios/client';

// Minimal fake koios client: only the methods under test need to be present.
type FakeKoios = {
  drepInfo: (id: string) => Promise<DrepInfo | null>;
  accountInfo: (addr: string) => Promise<AccountInfo | null>;
  proposalsByReturnAddress: (addr: string) => Promise<Array<{ proposal_id: string; return_address: string; proposal_type: string }>>;
};

function makeKoios(overrides: Partial<FakeKoios> = {}): FakeKoios {
  return {
    drepInfo: () => Promise.resolve(null),
    accountInfo: () => Promise.resolve(null),
    proposalsByReturnAddress: () => Promise.resolve([]),
    ...overrides,
  };
}

const DREP_ID = 'drep1ygfpzwl3u0r7e5dm6z7gz8afyw60rv5lnmtgcnw4nnrrzrdmytsk';
const STAKE_ADDR = 'stake1uxpdrerp9wrxunfh6ukyv5267j70fzxgw0fr3z8zeac5vyqhf9jhy';

function drepFixture(overrides: Partial<DrepInfo> = {}): DrepInfo {
  return {
    drep_id: DREP_ID,
    hex: 'abc123',
    has_script: false,
    drep_status: 'registered',
    deposit: '500000000',
    active: true,
    expires_epoch_no: 600,
    ...overrides,
  };
}

// --- resolveDRep ---

describe('resolveDRep', () => {
  it('returns isDrep true when registered, active, and not a script', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture()) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(true);
    expect(result.active).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns isDrep false with reason "script" when has_script is true', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ has_script: true })) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.reason).toBe('script');
  });

  it('returns isDrep false with reason "inactive" when registered but inactive', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ active: false })) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.active).toBe(false);
    expect(result.reason).toBe('inactive');
  });

  it('returns isDrep false with reason "not registered" when drep_status is retired', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ drep_status: 'retired' })) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.reason).toBe('not registered');
  });

  it('returns isDrep false when drepInfo returns null (not found)', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(null) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.active).toBe(false);
  });
});

// --- resolveProposer ---

describe('resolveProposer', () => {
  it('returns isProposer true with proposalIds when a match is found', async () => {
    const proposals = [
      { proposal_id: 'gov_action1abc', return_address: STAKE_ADDR, proposal_type: 'InfoAction' },
    ];
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve(proposals) });

    const result = await resolveProposer(koios, STAKE_ADDR);

    expect(result.isProposer).toBe(true);
    expect(result.proposalIds).toEqual(['gov_action1abc']);
  });

  it('filters out entries whose return_address does not match exactly (case-sensitive)', async () => {
    const otherAddr = STAKE_ADDR.toUpperCase();
    const proposals = [
      // Different address, should not match
      { proposal_id: 'gov_action1abc', return_address: otherAddr, proposal_type: 'InfoAction' },
      // Same address, should match
      { proposal_id: 'gov_action1def', return_address: STAKE_ADDR, proposal_type: 'TreasuryWithdrawals' },
    ];
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve(proposals) });

    const result = await resolveProposer(koios, STAKE_ADDR);

    expect(result.isProposer).toBe(true);
    expect(result.proposalIds).toEqual(['gov_action1def']);
  });

  it('returns isProposer false and empty proposalIds when no proposals are returned', async () => {
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve([]) });
    const result = await resolveProposer(koios, STAKE_ADDR);
    expect(result.isProposer).toBe(false);
    expect(result.proposalIds).toEqual([]);
  });

  it('returns isProposer false when no entry has a matching return_address', async () => {
    const proposals = [
      { proposal_id: 'gov_action1abc', return_address: 'stake1differentaddr', proposal_type: 'InfoAction' },
    ];
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve(proposals) });

    const result = await resolveProposer(koios, STAKE_ADDR);

    expect(result.isProposer).toBe(false);
    expect(result.proposalIds).toEqual([]);
  });
});
