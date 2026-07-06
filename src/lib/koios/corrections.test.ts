import { describe, expect, it } from 'vitest';
import type { VotingSummary } from './client.js';
import { spoEligiblePower, spoTallyPct } from './corrections.js';

describe('spoTallyPct', () => {
  it('passes Koios percentages through unchanged for non-hard-fork actions', () => {
    const s: VotingSummary = {
      proposal_type: 'TreasuryWithdrawals',
      pool_yes_pct: 73.1,
      pool_no_pct: 26.9,
      // Power buckets present but must be ignored for non-hard-fork types.
      pool_active_yes_vote_power: '1000',
      pool_no_vote_power: '500',
      pool_passive_always_abstain_vote_power: '9000',
    };
    expect(spoTallyPct(s)).toEqual({ yesPct: 73.1, noPct: 26.9 });
  });

  it('recomputes a hard fork by folding always-abstain back into the denominator', () => {
    // Real mainnet Van Rossem PV11 hard fork snapshot. Koios reports 51.64 / 48.36
    // (always-abstain wrongly dropped from the denominator); the ledger-correct
    // value folds always-abstain + always-no-confidence back into the No side.
    const s: VotingSummary = {
      proposal_type: 'HardForkInitiation',
      pool_yes_pct: 51.64,
      pool_no_pct: 48.36,
      pool_active_yes_vote_power: '7207875459435309',
      pool_no_vote_power: '6749855063953702',
      pool_passive_always_abstain_vote_power: '6928038498115586',
      pool_passive_always_no_confidence_vote_power: '54457503120251',
    };
    const { yesPct, noPct } = spoTallyPct(s);
    expect(yesPct).toBeCloseTo(34.42, 2);
    expect(noPct).toBeCloseTo(65.58, 2);
    // Well below the 51% hard-fork SPO threshold, unlike Koios' inflated 51.64%.
    expect(yesPct!).toBeLessThan(51);
  });

  it('falls back to Koios percentages for a hard fork when the power fields are absent', () => {
    const s: VotingSummary = {
      proposal_type: 'HardForkInitiation',
      pool_yes_pct: 51.64,
      pool_no_pct: 48.36,
    };
    expect(spoTallyPct(s)).toEqual({ yesPct: 51.64, noPct: 48.36 });
  });
});

describe('spoEligiblePower', () => {
  it('sums active yes/abstain + passive buckets + pool_no_vote_power', () => {
    const s = {
      pool_active_yes_vote_power: '10',
      pool_active_abstain_vote_power: '3',
      pool_passive_always_abstain_vote_power: '5',
      pool_passive_always_no_confidence_vote_power: '2',
      pool_no_vote_power: '80', // includes active_no + non-voting default-no
    } as any;
    // 10 + 3 + 5 + 2 + 80 = 100
    expect(spoEligiblePower(s)).toBe(100);
  });

  it('treats absent summands as 0', () => {
    expect(spoEligiblePower({ pool_no_vote_power: '50' } as any)).toBe(50);
  });

  it('is null when the pool power fields are entirely absent (older Koios)', () => {
    expect(spoEligiblePower({} as any)).toBeNull();
    expect(spoEligiblePower(null)).toBeNull();
  });
});
