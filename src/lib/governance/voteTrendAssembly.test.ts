import { describe, it, expect } from 'vitest';
import { assembleTrendInputs, type TrendAssemblyInputs } from './voteTrendAssembly.js';
import { resolveNetwork, epochStartUnix } from '@/lib/config/network.js';
import type { TrendVoteRow } from '@/lib/db/drepVotes.js';
import type { CcVote } from '@/lib/koios/corrections.js';
import type { CommitteeMemberTerm } from '@/lib/koios/committeeTimeline.js';

const cfg = resolveNetwork('preprod');

const action = (over: Partial<TrendAssemblyInputs['action']> = {}): TrendAssemblyInputs['action'] => ({
  submittedEpoch: 10,
  expiryEpoch: 20,
  decidedEpoch: 15,
  drepYesPct: 60,
  spoYesPct: 70,
  ccYesPct: 80,
  ...over,
});

const voteRow = (over: Partial<TrendVoteRow> = {}): TrendVoteRow => ({
  voter_role: 'DRep',
  voter_id: 'drep1',
  block_time: epochStartUnix(11, cfg),
  vote: 'Yes',
  voted_power: 100,
  ...over,
});

const member = (over: Partial<CommitteeMemberTerm> = {}): CommitteeMemberTerm => ({
  coldKeyHex: 'cold1',
  versionFrom: 0,
  versionTo: null,
  termExpiration: 100,
  authorizedFrom: 0,
  resignedAt: null,
  ...over,
});

describe('assembleTrendInputs', () => {
  it('uses epoch-start bounds for the window when both epochs are present', () => {
    const result = assembleTrendInputs({
      action: action(),
      trendRows: [voteRow()],
      ccVotes: [],
      committee: { members: [], hotToCold: new Map() },
      cfg,
    });
    expect(result.window.start).toBe(epochStartUnix(10, cfg));
    expect(result.window.end).toBe(epochStartUnix(15, cfg));
  });

  it('clamps the window end to the expiry epoch when the decision epoch is later', () => {
    // An enacted action can carry a decision epoch one past its expiry (enactment,
    // not ratification). Voting still ended at the start of the expiry epoch, so the
    // window must not stretch to the later epoch.
    const result = assembleTrendInputs({
      action: action({ decidedEpoch: 21, expiryEpoch: 20 }),
      trendRows: [voteRow()],
      ccVotes: [],
      committee: { members: [], hotToCold: new Map() },
      cfg,
    });
    expect(result.window.end).toBe(epochStartUnix(20, cfg));
  });

  it('falls back to the span of observed vote times when submittedEpoch is absent', () => {
    const earliestVote = epochStartUnix(10, cfg) + 1000;
    const latestVote = epochStartUnix(10, cfg) + 9000;
    const result = assembleTrendInputs({
      action: action({ submittedEpoch: null, decidedEpoch: null, expiryEpoch: null }),
      trendRows: [
        voteRow({ block_time: earliestVote }),
        voteRow({ block_time: latestVote, voter_id: 'drep2' }),
      ],
      ccVotes: [{ hotKeyHex: 'hot1', vote: 'Yes', blockTime: latestVote - 500 } satisfies CcVote],
      committee: { members: [], hotToCold: new Map() },
      cfg,
    });
    // Must span the observed vote times, not collapse to the {start:0, end:1} teaser bug.
    expect(result.window.start).toBe(earliestVote);
    expect(result.window.end).toBe(latestVote);
    expect(result.window.end).toBeGreaterThan(result.window.start);
  });

  it('computes body weights and ccSize for a small fixture', () => {
    const decidedEpoch = 15;
    const hotToCold = new Map([['hot1', 'cold1'], ['hot2', 'cold2']]);
    const members = [member({ coldKeyHex: 'cold1' }), member({ coldKeyHex: 'cold2' })];
    const ccVotes: CcVote[] = [
      { hotKeyHex: 'hot1', vote: 'Yes', blockTime: epochStartUnix(12, cfg) },
      { hotKeyHex: 'hot2', vote: 'No', blockTime: epochStartUnix(12, cfg) },
    ];
    const trendRows: TrendVoteRow[] = [
      voteRow({ voter_role: 'DRep', voted_power: 30, block_time: epochStartUnix(11, cfg) }),
      voteRow({ voter_role: 'DRep', voted_power: 70, voter_id: 'drep2', block_time: epochStartUnix(12, cfg) }),
      voteRow({ voter_role: 'SPO', voted_power: 40, voter_id: 'pool1', block_time: epochStartUnix(13, cfg) }),
    ];

    const result = assembleTrendInputs({
      action: action({ decidedEpoch }),
      trendRows,
      ccVotes,
      committee: { members, hotToCold },
      cfg,
    });

    expect(result.ccSize).toBe(2);
    expect(result.ccYesCount).toBe(1);

    const drep = result.inputs.find((b) => b.key === 'DRep')!;
    expect(drep.yesVotes).toHaveLength(2);
    expect(drep.yesVotes.reduce((s, v) => s + v.weight, 0)).toBe(100);
    expect(drep.finalPct).toBe(60);
    expect(drep.thresholdPct).toBeNull();
    expect(drep.finalLabel).toBe('');

    const spo = result.inputs.find((b) => b.key === 'SPO')!;
    expect(spo.yesVotes).toHaveLength(1);
    expect(spo.yesVotes[0].weight).toBe(40);

    const cc = result.inputs.find((b) => b.key === 'CC')!;
    expect(cc.yesVotes).toHaveLength(1);
    expect(cc.yesVotes[0].weight).toBe(1);
  });

  it('keeps the full window on the axis but stops the line at nowSec for an active action', () => {
    const nowSec = epochStartUnix(15, cfg);
    const result = assembleTrendInputs({
      // Active: not decided, expiry epoch 20 is still in the future relative to now.
      action: action({ decidedEpoch: null, expiryEpoch: 20 }),
      trendRows: [voteRow()],
      ccVotes: [],
      committee: { members: [], hotToCold: new Map() },
      cfg,
      nowSec,
    });
    // Axis domain spans to the expiry epoch, the deadline stays visible on the right.
    expect(result.window.end).toBe(epochStartUnix(20, cfg));
    // The line stops at now, not the future expiry.
    expect(result.lineEnd).toBe(nowSec);
    expect(result.lineEnd).toBeLessThan(result.window.end);
  });

  it('has lineEnd equal to the window end for a terminal action even with nowSec set', () => {
    const result = assembleTrendInputs({
      action: action({ decidedEpoch: 15 }),
      trendRows: [voteRow()],
      ccVotes: [],
      committee: { members: [], hotToCold: new Map() },
      cfg,
      nowSec: epochStartUnix(30, cfg), // well after the decision epoch
    });
    expect(result.window.end).toBe(epochStartUnix(15, cfg));
    expect(result.lineEnd).toBe(epochStartUnix(15, cfg));
  });
});
