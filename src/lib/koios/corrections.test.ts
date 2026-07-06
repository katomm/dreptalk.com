import { describe, expect, it } from 'vitest';
import type { VotingSummary } from './client.js';
import type { CommitteeMemberTerm } from './committeeTimeline.js';
import { ccTallyPct, spoEligiblePower, spoTallyPct, type CcVote } from './corrections.js';

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

describe('ccTallyPct', () => {
  // Committee v3: 8 members active at epoch 634 (terms valid, none resigned in range).
  const v3: CommitteeMemberTerm[] = Array.from({ length: 8 }, (_, i) => ({
    coldKeyHex: `cold${i}`,
    versionFrom: 602,
    versionTo: null as number | null,
    termExpiration: 653,
    authorizedFrom: 507,
    resignedAt: null as number | null,
  }));

  it('collapses rotated and re-voted hot keys to one vote per member (action-97 shape)', () => {
    // 7 of 8 members vote Yes, cast via 11 hot-key rows: 4 members rotated (2 hot keys each).
    const hotToCold = new Map<string, string>([
      ['h0', 'cold0'], ['h0b', 'cold0'],
      ['h1', 'cold1'], ['h1b', 'cold1'],
      ['h2', 'cold2'], ['h2b', 'cold2'],
      ['h3', 'cold3'], ['h3b', 'cold3'],
      ['h4', 'cold4'], ['h5', 'cold5'], ['h6', 'cold6'],
      // cold7 does not vote -> counts as No in the denominator
    ]);
    const votes: CcVote[] = [
      { hotKeyHex: 'h0', vote: 'Yes', blockTime: 1 }, { hotKeyHex: 'h0b', vote: 'Yes', blockTime: 2 },
      { hotKeyHex: 'h1', vote: 'Yes', blockTime: 1 }, { hotKeyHex: 'h1b', vote: 'Yes', blockTime: 2 },
      { hotKeyHex: 'h2', vote: 'Yes', blockTime: 1 }, { hotKeyHex: 'h2b', vote: 'Yes', blockTime: 2 },
      { hotKeyHex: 'h3', vote: 'Yes', blockTime: 1 }, { hotKeyHex: 'h3b', vote: 'Yes', blockTime: 2 },
      { hotKeyHex: 'h4', vote: 'Yes', blockTime: 1 },
      { hotKeyHex: 'h5', vote: 'Yes', blockTime: 1 },
      { hotKeyHex: 'h6', vote: 'Yes', blockTime: 1 },
    ];
    // 11 raw Yes rows -> 7 distinct members Yes; size 8, no abstain -> 7/8 = 87.5.
    expect(ccTallyPct(votes, v3, hotToCold, 634)).toEqual({ yesPct: 87.5, noPct: 12.5, yes: 7, no: 0, abstain: 0 });
  });

  it('excludes abstaining members from the denominator', () => {
    const hotToCold = new Map(v3.map((m, i) => [`h${i}`, m.coldKeyHex]));
    const votes: CcVote[] = [
      ...[0, 1, 2, 3, 4].map((i) => ({ hotKeyHex: `h${i}`, vote: 'Yes' as const, blockTime: 1 })),
      { hotKeyHex: 'h5', vote: 'Abstain', blockTime: 1 },
      { hotKeyHex: 'h6', vote: 'Abstain', blockTime: 1 },
      // cold7 does not vote
    ];
    // 5 yes, 2 abstain, 8 active -> denom 6 -> 5/6 = 83.33.
    expect(ccTallyPct(votes, v3, hotToCold, 634)).toEqual({ yesPct: 83.33, noPct: 16.67, yes: 5, no: 0, abstain: 2 });
  });

  it('drops a resigned member from numerator and denominator (epoch-597 boundary)', () => {
    // Committee v2 at epoch 597: the resigner is out, 6 active members remain.
    const v2: CommitteeMemberTerm[] = [
      { coldKeyHex: 'resigner', versionFrom: 581, versionTo: 601, termExpiration: 653, authorizedFrom: 507, resignedAt: 597 },
      ...Array.from({ length: 6 }, (_, i) => ({
        coldKeyHex: `c${i}`,
        versionFrom: 581,
        versionTo: 601 as number | null,
        termExpiration: 653,
        authorizedFrom: 507,
        resignedAt: null as number | null,
      })),
    ];
    const hotToCold = new Map<string, string>([
      ['hr', 'resigner'],
      ...Array.from({ length: 6 }, (_, i) => [`h${i}`, `c${i}`] as [string, string]),
    ]);
    const votes: CcVote[] = [
      { hotKeyHex: 'hr', vote: 'Yes', blockTime: 1 }, // resigner voted before resigning; must NOT count
      ...Array.from({ length: 6 }, (_, i) => ({ hotKeyHex: `h${i}`, vote: 'Yes' as const, blockTime: 1 })),
    ];
    // Without the active-member filter this reads 7/6 > 100 %. Correct: 6 yes / 6 active = 100 %.
    expect(ccTallyPct(votes, v2, hotToCold, 597)).toEqual({ yesPct: 100, noPct: 0, yes: 6, no: 0, abstain: 0 });
  });

  it('is null when no committee is active at the epoch', () => {
    expect(ccTallyPct([], v3, new Map(), 700)).toEqual({ yesPct: null, noPct: null, yes: 0, no: 0, abstain: 0 });
  });
});
