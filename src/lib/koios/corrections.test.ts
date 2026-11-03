import { describe, expect, it } from 'vitest';
import type { CommitteeMemberTerm } from './committeeTimeline.js';
import { epochStartUnix, resolveNetwork } from '../config/network.js';
import { evaluateThresholds } from '../governance/thresholds.js';
import type { ProtocolParams } from '../db/protocolParams.js';
import {
  ccFinalVotesByMember,
  ccTallyPct,
  finalCcVoteByMember,
  spoEligiblePower,
  type CcVote,
} from './corrections.js';

describe('spoEligiblePower', () => {
  it('sums active yes/abstain + always-abstain + pool_no_vote_power', () => {
    const s = {
      pool_active_yes_vote_power: '10',
      pool_active_abstain_vote_power: '3',
      pool_passive_always_abstain_vote_power: '5',
      pool_passive_always_no_confidence_vote_power: '2',
      pool_no_vote_power: '80', // active_no + non-voting default-no + the ANC 2
    } as any;
    // 10 + 3 + 5 + 80 = 98. The always-no-confidence 2 is deliberately NOT a
    // summand: it is already inside pool_no_vote_power, and adding it again is
    // the double count this function used to carry.
    expect(spoEligiblePower(s)).toBe(98);
  });

  it('does not double count always-no-confidence into the denominator', () => {
    const withAnc = {
      pool_active_yes_vote_power: '5000',
      pool_no_vote_power: '5000',
      pool_passive_always_no_confidence_vote_power: '1000',
    } as any;
    expect(spoEligiblePower(withAnc)).toBe(10_000);
  });

  it('counts always-abstain once on a hard fork, where pool_no_vote_power already holds it', () => {
    // Koios today for the van Rossem hard fork (epoch 643): yes + no side + voted
    // abstain is 21.40B of 21.41B active stake. Adding the always-abstain bucket
    // would claim 25.41B, more stake than exists.
    const vanRossem = {
      proposal_type: 'HardForkInitiation',
      pool_active_yes_vote_power: '10445177677947930',
      pool_no_vote_power: '9254034669953667',
      pool_active_abstain_vote_power: '1699130913945099',
      pool_passive_always_abstain_vote_power: '4010227408074541',
      pool_passive_always_no_confidence_vote_power: '52023987145075',
    } as any;
    const counted = 10_445_177_677_947_930n + 9_254_034_669_953_667n + 1_699_130_913_945_099n;
    expect(spoEligiblePower(vanRossem)).toBeCloseTo(Number(counted), -3);
    // Every other type keeps the bucket outside the No side and sums it in.
    expect(spoEligiblePower({ ...vanRossem, proposal_type: 'InfoAction' })).toBeCloseTo(
      Number(counted + 4_010_227_408_074_541n),
      -3,
    );
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

  it('drops a resigned member from numerator and denominator once the boundary after the resignation has passed', () => {
    // Committee v2 judged at the boundary to 598: the epoch-597 resigner is out, 6 members remain.
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
    expect(ccTallyPct(votes, v2, hotToCold, 598)).toEqual({ yesPct: 100, noPct: 0, yes: 6, no: 0, abstain: 0 });
    // At the boundary to 597 itself the resignation had not happened yet: 7 of 7.
    expect(ccTallyPct(votes, v2, hotToCold, 597)).toEqual({ yesPct: 100, noPct: 0, yes: 7, no: 0, abstain: 0 });
  });

  it('is null when no committee is active at the epoch', () => {
    expect(ccTallyPct([], v3, new Map(), 700)).toEqual({ yesPct: null, noPct: null, yes: 0, no: 0, abstain: 0 });
  });
});

describe('ccTallyPct with the vote cutoff of a decided action', () => {
  // Real mainnet cases checked against the ledger. The committee of seven
  // seated at both boundaries, keyed by hot key prefix for readability.
  const hots = ['64f97568', '84feba94', '646d1b3a', '725d4d44', '71aa5b3a', '68bb0b42', '2ea7a78e'];
  const members: CommitteeMemberTerm[] = hots.map((h) => ({
    coldKeyHex: `cold_${h}`, versionFrom: 602, versionTo: null, termExpiration: 700, authorizedFrom: 507, resignedAt: null,
  }));
  const hotToCold = new Map(hots.map((h) => [h, `cold_${h}`]));
  const mainnet = resolveNetwork('mainnet');

  it('leaves out a vote cast during the tally epoch and keeps the exact 2/3 met (2f2fc253, T 620)', () => {
    const cutoff = epochStartUnix(620, mainnet);
    expect(cutoff).toBe(1774043091);
    const votes: CcVote[] = [
      { hotKeyHex: '64f97568', vote: 'Abstain', blockTime: 1771916313 },
      { hotKeyHex: '84feba94', vote: 'Yes', blockTime: 1772061882 },
      { hotKeyHex: '646d1b3a', vote: 'Yes', blockTime: 1772477421 },
      { hotKeyHex: '725d4d44', vote: 'Yes', blockTime: 1773482211 },
      { hotKeyHex: '71aa5b3a', vote: 'Yes', blockTime: 1773520698 },
      { hotKeyHex: '68bb0b42', vote: 'Yes', blockTime: 1774062984 }, // inside epoch 620
    ];
    const t = ccTallyPct(votes, members, hotToCold, 620, cutoff);
    expect(t).toEqual({ yesPct: 66.67, noPct: 33.33, yes: 4, no: 0, abstain: 1 });
    // Without the cutoff it reads 5 of 6 counted seats, the stored value the ledger never saw.
    expect(ccTallyPct(votes, members, hotToCold, 620).yesPct).toBe(83.33);

    // Mainnet's committee threshold is exactly 2/3, so 66.67 clears 66.666...
    const params = {
      dvtTreasuryWithdrawal: 0.67, ccThreshold: 2 / 3, committeeMinSize: 7, committeeSize: 7,
    } as ProtocolParams;
    const cc = evaluateThresholds({ type: 'TreasuryWithdrawals', drepYesPct: null, spoYesPct: null, ccYesPct: t.yesPct }, params)
      .find((r) => r.body === 'CC');
    expect(cc?.met).toBe(true);
  });

  it('counts six of seven on fdd468da (T 643), never the Koios denominator of eight', () => {
    const cutoff = epochStartUnix(643, mainnet);
    const votes: CcVote[] = [
      { hotKeyHex: '725d4d44', vote: 'Yes', blockTime: 1782304021 },
      { hotKeyHex: '646d1b3a', vote: 'Yes', blockTime: 1783346333 },
      { hotKeyHex: '84feba94', vote: 'Yes', blockTime: 1783378108 },
      { hotKeyHex: '71aa5b3a', vote: 'Yes', blockTime: 1783572452 },
      { hotKeyHex: '64f97568', vote: 'Yes', blockTime: 1783949204 },
      { hotKeyHex: '68bb0b42', vote: 'Yes', blockTime: 1783977211 },
      { hotKeyHex: '2ea7a78e', vote: 'Yes', blockTime: cutoff + 3600 }, // late vote, in db-sync only so far
    ];
    expect(ccTallyPct(votes, members, hotToCold, 643, cutoff)).toEqual({ yesPct: 85.71, noPct: 14.29, yes: 6, no: 0, abstain: 0 });
  });

  it('counts the in-time vote of a member who changed it during the tally epoch', () => {
    const cutoff = 1000;
    const votes: CcVote[] = [
      { hotKeyHex: '84feba94', vote: 'Yes', blockTime: 900 }, // superseded row from the vote history
      { hotKeyHex: '84feba94', vote: 'No', blockTime: 1100 }, // current row, cast too late
    ];
    expect(ccTallyPct(votes, members, hotToCold, 643, cutoff)).toMatchObject({ yes: 1, no: 0 });
    // Without a cutoff the latest vote stands.
    expect(ccTallyPct(votes, members, hotToCold, 643, null)).toMatchObject({ yes: 0, no: 1 });
  });

  it('keeps a vote without a block time, which cannot be placed on either side', () => {
    const votes: CcVote[] = [{ hotKeyHex: '84feba94', vote: 'Yes', blockTime: null }];
    expect(ccTallyPct(votes, members, hotToCold, 643, 1000)).toMatchObject({ yes: 1 });
  });
});

describe('ccFinalVotesByMember', () => {
  const member = (cold: string): CommitteeMemberTerm => ({
    coldKeyHex: cold, versionFrom: 1, versionTo: null, termExpiration: 999, authorizedFrom: 1, resignedAt: null,
  });

  it('keeps the latest vote per cold-key member across a hot-key rotation', () => {
    const members = [member('coldA'), member('coldB')];
    const hotToCold = new Map([['hotA1', 'coldA'], ['hotA2', 'coldA'], ['hotB', 'coldB']]);
    const res = ccFinalVotesByMember(
      [
        { hotKeyHex: 'hotA1', vote: 'No', blockTime: 100 },
        { hotKeyHex: 'hotA2', vote: 'Yes', blockTime: 200 }, // rotated key, later, wins
        { hotKeyHex: 'hotB', vote: 'Yes', blockTime: 150 },
      ],
      members, hotToCold, 5,
    );
    const byCold = Object.fromEntries(res.map((r) => [r.coldKeyHex, r]));
    expect(byCold.coldA.vote).toBe('Yes');
    expect(byCold.coldA.blockTime).toBe(200);
    expect(byCold.coldB.vote).toBe('Yes');
    expect(res).toHaveLength(2);
  });

  it('ignores votes from members not active at the epoch or with an unknown hot key', () => {
    const members = [member('coldB')];
    const hotToCold = new Map([['hotB', 'coldB']]);
    const res = ccFinalVotesByMember(
      [
        { hotKeyHex: 'hotB', vote: 'Yes', blockTime: 150 },
        { hotKeyHex: 'unknownHot', vote: 'Yes', blockTime: 300 },
      ],
      members, hotToCold, 5,
    );
    expect(res).toHaveLength(1);
    expect(res[0].coldKeyHex).toBe('coldB');
  });
});

describe('finalCcVoteByMember', () => {
  const members: CommitteeMemberTerm[] = [
    { coldKeyHex: 'colda', versionFrom: 0, versionTo: null, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
    { coldKeyHex: 'coldb', versionFrom: 0, versionTo: null, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
  ];

  it('keeps the latest vote per active member and drops inactive/unknown hot keys', () => {
    const hotToCold = new Map([
      ['h1', 'colda'],
      ['h2', 'colda'],
      ['hb', 'coldb'],
      ['hz', 'coldZZZ'],
    ]);
    const votes = [
      { hotKeyHex: 'h1', vote: 'No' as const, blockTime: 5 },
      { hotKeyHex: 'h2', vote: 'Yes' as const, blockTime: 30 }, // same member, newer, wins
      { hotKeyHex: 'hz', vote: 'Yes' as const, blockTime: 99 }, // unknown cold, dropped
    ];
    const m = finalCcVoteByMember(votes, members, hotToCold, 500);
    expect(m.get('colda')?.vote).toBe('Yes');
    expect(m.has('coldb')).toBe(false);
  });
});
