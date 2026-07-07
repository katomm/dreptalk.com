import { describe, it, expect } from 'vitest';
import {
  readableType,
  formatAda,
  statusBadge,
  govStatusVerb,
  isTerminalStatus,
  epochCountdown,
  epochDaysLeft,
  tallyBar,
  voteTone,
  fmtPct,
  fmtPctFine,
  formatEpochDate,
  govTypeTone,
  govActionOgImage,
  threadOgImage,
  isSpoLedType,
  overviewTally,
  headlineComposition,
  overviewRowVoting,
  compositionBar,
  bodyComposition,
  compositionAmounts,
  absentBodyNote,
  TERMINAL_STATUSES,
  type RoleTallyInput,
  type RowVotingInput,
} from './view.js';
import { spoTallyPct } from '../koios/corrections.js';
import type { VotingSummary } from '../koios/client.js';

describe('readableType / formatAda', () => {
  it('spaces camelCase types', () => {
    expect(readableType('TreasuryWithdrawals')).toBe('Treasury Withdrawals');
  });
  it('formats lovelace to ADA, null on garbage', () => {
    expect(formatAda('100000000000')).toBe('100,000 ₳');
    expect(formatAda(null)).toBeNull();
    expect(formatAda('abc')).toBeNull();
  });
});

describe('statusBadge', () => {
  it('shows a freshly discovered (pending) action as Syncing, neutral', () => {
    expect(statusBadge('pending')).toEqual({ label: 'Syncing', tone: 'neutral' });
  });
  it('maps known statuses to tones', () => {
    expect(statusBadge('active').tone).toBe('active');
    expect(statusBadge('enacted').tone).toBe('positive');
    expect(statusBadge('ratified').tone).toBe('positive');
    expect(statusBadge('dropped').tone).toBe('negative');
    expect(statusBadge('expired').tone).toBe('neutral');
  });
  it('labels a closed info action neutrally', () => {
    expect(statusBadge('closed')).toEqual({ label: 'Closed', tone: 'neutral' });
  });
  it('capitalizes an unknown status', () => {
    expect(statusBadge('weird')).toEqual({ label: 'Weird', tone: 'neutral' });
  });
});

describe('isTerminalStatus', () => {
  it('is true for frozen outcomes', () => {
    for (const s of ['ratified', 'enacted', 'dropped', 'expired', 'closed']) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });
  it('is false for still-open and unknown statuses', () => {
    expect(isTerminalStatus('active')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('weird')).toBe(false);
  });

  it('TERMINAL_STATUSES is the single source isTerminalStatus draws from', () => {
    // The list is also spread into the Closing-Soon SQL filter, so it must stay in
    // lockstep with the predicate.
    for (const s of TERMINAL_STATUSES) expect(isTerminalStatus(s)).toBe(true);
    expect([...TERMINAL_STATUSES].sort()).toEqual(['closed', 'dropped', 'enacted', 'expired', 'ratified']);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed reference instant for deterministic tests

describe('epochDaysLeft', () => {
  it('counts whole calendar days (rounding up) from now to the expiry-epoch boundary', () => {
    expect(epochDaysLeft(NOW + 5 * DAY_MS, 'active', NOW)).toBe(5);
    // A partial day rounds up: an action whose voting closes in ~1.4 days reads as
    // "2 days", never the old whole-epoch estimate of 5. This is the bug fixed here:
    // the previous (expiryEpoch - tallyEpoch) * 5 ignored how far we already were
    // into the current epoch and so over-counted by up to a full 5-day epoch.
    expect(epochDaysLeft(NOW + Math.round(1.4 * DAY_MS), 'active', NOW)).toBe(2);
    expect(epochDaysLeft(NOW + Math.round(0.1 * DAY_MS), 'active', NOW)).toBe(1);
  });
  it('returns null once the boundary has passed or is unknown', () => {
    expect(epochDaysLeft(NOW, 'active', NOW)).toBeNull();
    expect(epochDaysLeft(NOW - DAY_MS, 'active', NOW)).toBeNull();
    expect(epochDaysLeft(null, 'active', NOW)).toBeNull();
  });
  it('returns null for a terminal status even with a future boundary, counts for pending', () => {
    expect(epochDaysLeft(NOW + 5 * DAY_MS, 'ratified', NOW)).toBeNull();
    expect(epochDaysLeft(NOW + 5 * DAY_MS, 'pending', NOW)).toBe(5);
  });
});

describe('epochCountdown', () => {
  it('renders the day count to the boundary with the expiry epoch label', () => {
    expect(epochCountdown(639, NOW + Math.round(1.4 * DAY_MS), 'active', NOW)).toBe(
      '~2 days left (epoch 639)',
    );
  });
  it('singularizes a single remaining day', () => {
    expect(epochCountdown(639, NOW + Math.round(0.5 * DAY_MS), 'active', NOW)).toBe(
      '~1 day left (epoch 639)',
    );
  });
  it('returns null when past, unknown, or terminal', () => {
    expect(epochCountdown(639, NOW - DAY_MS, 'active', NOW)).toBeNull();
    expect(epochCountdown(null, null, 'active', NOW)).toBeNull();
    // An action ratified or enacted before its boundary keeps a future epoch;
    // it must not read as "still counting down".
    expect(epochCountdown(639, NOW + 5 * DAY_MS, 'enacted', NOW)).toBeNull();
  });
});

describe('tallyBar', () => {
  it('derives abstain as the remainder and clamps', () => {
    expect(tallyBar(0.01, 99.99)).toEqual({ yes: 0.01, no: 99.99, abstain: 0 });
    expect(tallyBar(30, 20)).toEqual({ yes: 30, no: 20, abstain: 50 });
  });
  it('returns null when no tally exists', () => {
    expect(tallyBar(null, null)).toBeNull();
  });
});

describe('fmtPct', () => {
  it('uses two decimals for tiny non-zero values and whole numbers otherwise', () => {
    expect(fmtPct(0.01)).toBe('0.01%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(99.99)).toBe('100%');
    expect(fmtPct(30)).toBe('30%');
  });
});

describe('formatEpochDate', () => {
  it('formats a unix-seconds epoch boundary as a UTC short date', () => {
    expect(formatEpochDate(1596059091)).toBe('Jul 29, 2020'); // mainnet epoch 208 boundary
    expect(formatEpochDate(1655769600)).toBe('Jun 21, 2022'); // preprod epoch 0 boundary
  });
});

describe('govTypeTone', () => {
  it('maps known governance action types to a color tone', () => {
    expect(govTypeTone('NewConstitution')).toBe('constitution');
    expect(govTypeTone('TreasuryWithdrawals')).toBe('treasury');
    expect(govTypeTone('ParameterChange')).toBe('parameter');
    expect(govTypeTone('InfoAction')).toBe('info');
    expect(govTypeTone('HardForkInitiation')).toBe('hardfork');
    expect(govTypeTone('NewCommittee')).toBe('committee');
    expect(govTypeTone('NoConfidence')).toBe('noconfidence');
  });
  it('is case- and spacing-insensitive', () => {
    expect(govTypeTone('treasury withdrawals')).toBe('treasury');
    expect(govTypeTone('Hard Fork Initiation')).toBe('hardfork');
  });
  it('falls back to other for unknown types', () => {
    expect(govTypeTone('SomethingElse')).toBe('other');
  });
});

describe('govActionOgImage', () => {
  it('maps each known type to its per-type OG card', () => {
    expect(govActionOgImage('TreasuryWithdrawals')).toBe('/og/gov-treasury.png');
    expect(govActionOgImage('HardForkInitiation')).toBe('/og/gov-hardfork.png');
    expect(govActionOgImage('InfoAction')).toBe('/og/gov-info.png');
    expect(govActionOgImage('NoConfidence')).toBe('/og/gov-noconfidence.png');
  });
  it('falls back to the site OG image for unknown types', () => {
    expect(govActionOgImage('SomethingElse')).toBe('/og.jpg');
  });
});

describe('threadOgImage', () => {
  it('uses the per-type card for a governance action', () => {
    expect(threadOgImage({ type: 'TreasuryWithdrawals' }, true)).toBe('/og/gov-treasury.png');
  });
  it('uses the discussion card for a plain thread', () => {
    expect(threadOgImage(null, false)).toBe('/og/discussion.png');
  });
  it('defers to the site default for a governance topic without a synced action', () => {
    expect(threadOgImage(null, true)).toBeUndefined();
  });
});

describe('voteTone', () => {
  it('maps votes to tones case-insensitively', () => {
    expect(voteTone('Yes')).toBe('positive');
    expect(voteTone('no')).toBe('negative');
    expect(voteTone('Abstain')).toBe('neutral');
  });
});

// Minimal RoleTallyInput builder: empty tallies, overridable per role. Shared by
// the overviewTally suite below.
const make = (over: Partial<RoleTallyInput>): RoleTallyInput => ({
  type: 'TreasuryWithdrawals',
  status: 'active',
  drepYesPct: null, drepNoPct: null, drepYes: null, drepNo: null, drepAbstain: null,
  spoYesPct: null, spoNoPct: null, spoYes: null, spoNo: null, spoAbstain: null,
  ...over,
});

describe('isSpoLedType / overviewTally', () => {
  it('flags only the hard fork as SPO-led', () => {
    expect(isSpoLedType('HardForkInitiation')).toBe(true);
  });
  it('leaves every other type DRep-led, incl. SPO co-decided no-confidence and committee', () => {
    expect(isSpoLedType('NoConfidence')).toBe(false);
    expect(isSpoLedType('NewCommittee')).toBe(false);
    expect(isSpoLedType('TreasuryWithdrawals')).toBe(false);
    expect(isSpoLedType('ParameterChange')).toBe(false);
    expect(isSpoLedType('NewConstitution')).toBe(false);
    expect(isSpoLedType('InfoAction')).toBe(false);
  });

  it('a no-confidence / committee action leads with its DRep tally', () => {
    const noConf = overviewTally(make({ type: 'NoConfidence', drepYesPct: 70, drepNoPct: 30, drepYes: 5, drepNo: 2, drepAbstain: 0, spoYesPct: 0, spoNoPct: 0 }))!;
    expect(noConf.role).toBe('DRep');
    const committee = overviewTally(make({ type: 'NewCommittee', drepYesPct: 79, drepNoPct: 21, drepYes: 200, drepNo: 70, drepAbstain: 6, spoYesPct: 0, spoNoPct: 0 }))!;
    expect(committee.role).toBe('DRep');
    expect(committee.voted).toBe(276);
  });

  it('a DRep-led type with a DRep tally leads with DRep', () => {
    const t = overviewTally(make({ type: 'TreasuryWithdrawals', drepYesPct: 79, drepNoPct: 21, drepYes: 200, drepNo: 70, drepAbstain: 6 }))!;
    expect(t.role).toBe('DRep');
    expect(t.bar.yes).toBe(79);
    expect(t.voted).toBe(276);
  });
  it('a hard fork with an SPO tally leads with SPO', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', spoYesPct: 95, spoNoPct: 1, spoYes: 300, spoNo: 3, spoAbstain: 0, drepYesPct: 0, drepNoPct: 0 }))!;
    expect(t.role).toBe('SPO');
    expect(t.bar.yes).toBe(95);
    expect(t.voted).toBe(303);
  });
  it('a hard fork with no SPO tally falls back to the DRep tally', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', drepYesPct: 60, drepNoPct: 40, drepYes: 10, drepNo: 5, drepAbstain: 1 }))!;
    expect(t.role).toBe('DRep');
    expect(t.voted).toBe(16);
  });
  it('a DRep-led type with only an SPO tally falls back to SPO', () => {
    const t = overviewTally(make({ type: 'ParameterChange', spoYesPct: 50, spoNoPct: 10, spoYes: 4, spoNo: 1, spoAbstain: 0 }))!;
    expect(t.role).toBe('SPO');
  });
  it('returns null when neither role has a tally', () => {
    expect(overviewTally(make({ type: 'HardForkInitiation' }))).toBeNull();
    expect(overviewTally(make({ type: 'TreasuryWithdrawals' }))).toBeNull();
  });

  it('flags the SPO no-share as pending on an open hard fork where no pool voted No', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', status: 'active', spoYesPct: 16, spoNoPct: 84, spoYes: 68, spoNo: 0, spoAbstain: 0 }))!;
    expect(t.role).toBe('SPO');
    expect(t.noIsPending).toBe(true);
  });
  it('does not flag pending once a pool has actually voted No', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', status: 'active', spoYesPct: 60, spoNoPct: 40, spoYes: 100, spoNo: 5, spoAbstain: 0 }))!;
    expect(t.noIsPending).toBe(false);
  });
  it('does not flag pending once the hard fork is terminal', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', status: 'expired', spoYesPct: 16, spoNoPct: 84, spoYes: 68, spoNo: 0, spoAbstain: 0 }))!;
    expect(t.noIsPending).toBe(false);
  });
  it('does not flag pending when there is no no-share to relabel', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', status: 'active', spoYesPct: 100, spoNoPct: 0, spoYes: 68, spoNo: 0, spoAbstain: 0 }))!;
    expect(t.noIsPending).toBe(false);
  });
  it('never flags pending for a DRep-led bar', () => {
    const t = overviewTally(make({ type: 'TreasuryWithdrawals', status: 'active', drepYesPct: 20, drepNoPct: 80, drepYes: 10, drepNo: 0, drepAbstain: 0 }))!;
    expect(t.role).toBe('DRep');
    expect(t.noIsPending).toBe(false);
  });
});

describe('govStatusVerb', () => {
  it('maps statuses to past-tense feed verbs', () => {
    expect(govStatusVerb('enacted')).toBe('was enacted');
    expect(govStatusVerb('ratified')).toBe('was ratified');
    expect(govStatusVerb('dropped')).toBe('was dropped');
    expect(govStatusVerb('expired')).toBe('expired');
    expect(govStatusVerb('closed')).toBe('was closed');
  });

  it('falls back to a generic phrase for an unknown status', () => {
    expect(govStatusVerb('whatever')).toBe('is now whatever');
    // 'active' is intentionally not a feed verb: pending -> active is suppressed,
    // so only terminal outcomes ever reach govStatusVerb.
    expect(govStatusVerb('active')).toBe('is now active');
  });
});

describe('overviewRowVoting', () => {
  // Minimal RowVotingInput builder: every field defaults to null/0 and is
  // overridable per test. Mirrors the `make` helper above for RoleTallyInput.
  const makeRow = (over: Partial<RowVotingInput>): RowVotingInput => ({
    type: 'InfoAction',
    drepYesPct: null, drepNoPct: null,
    spoYesPct: null, spoNoPct: null,
    ccYesPct: null, ccNoPct: null,
    drepYes: null, drepNo: null, drepAbstain: null,
    spoYes: null, spoNo: null, spoAbstain: null,
    ccYes: null, ccNo: null, ccAbstain: null,
    drepYesPower: null, drepNoPower: null, drepAbstainPower: null,
    spoYesPower: null, spoNoPower: null, spoAbstainPower: null,
    drepVotedPower: null,
    spoEligiblePower: null,
    ...over,
  });

  it('treasury withdrawals: DRep + CC only (no SPO), composition leads with the stored yes pct, participation from stake totals', () => {
    const a = makeRow({
      type: 'TreasuryWithdrawals',
      drepYesPct: 79, drepNoPct: 21,
      ccYesPct: 83, ccNoPct: 17,
      drepVotedPower: 250_000_000,
      ccYes: 4, ccNo: 1, ccAbstain: 0,
    });
    const result = overviewRowVoting(a, { drepStakeTotal: 1_000_000_000, committeeSize: 5 });

    expect(result.bodies.map((b) => b.body)).toEqual(['DRep', 'CC']);
    expect(result.absentBodies).toEqual(['SPO']);

    const drep = result.bodies[0];
    expect(drep.composition?.yes).toBe(79); // pinned to the stored ratification pct
    expect(drep.participation).toBe(25); // 250M / 1B * 100

    const cc = result.bodies[1];
    expect(cc.composition?.yes).toBe(83);
    expect(cc.participation).toBe(100); // (4+1+0) / 5 * 100
  });

  it('info action: all three bodies, composition leads with yes-of-eligible, null when a body has no synced pct', () => {
    const a = makeRow({
      type: 'InfoAction',
      drepYesPct: 6.84,
      drepYesPower: 99, drepNoPower: 1, drepAbstainPower: 0,
      ccYesPct: 75, ccYes: 3, ccNo: 1, ccAbstain: 0,
      drepVotedPower: 100,
    });
    const result = overviewRowVoting(a, { drepStakeTotal: 1000, committeeSize: 7 });

    expect(result.bodies.map((b) => b.body)).toEqual(['DRep', 'SPO', 'CC']);
    expect(result.absentBodies).toEqual([]);

    const drep = result.bodies[0];
    expect(drep.composition?.yes).toBeCloseTo(6.84, 5);

    const spo = result.bodies[1];
    expect(spo.composition).toBeNull(); // no spoYesPct synced

    const cc = result.bodies[2];
    expect(cc.composition?.yes).toBe(75);
  });

  it('hard fork initiation: SPO ratification bar uses the spoTallyPct recompute, DRep with 0 cast still listed with null vote', () => {
    // Koios' raw pool_yes_pct (buggy for hard forks) would read 95, but the
    // recompute folding always-abstain/always-no-confidence back into No gives 60.
    const summary = {
      proposal_type: 'HardForkInitiation',
      pool_yes_pct: 95,
      pool_no_pct: 5,
      pool_active_yes_vote_power: '600',
      pool_no_vote_power: '100',
      pool_passive_always_abstain_vote_power: '300',
      pool_passive_always_no_confidence_vote_power: '0',
    } as unknown as VotingSummary;
    const recomputed = spoTallyPct(summary);
    expect(recomputed.yesPct).not.toBe(95); // sanity: Koios pct != recompute

    const a = makeRow({
      type: 'HardForkInitiation',
      drepYesPct: null, drepNoPct: null, // bootstrap: no DRep cast yet
      spoYesPct: recomputed.yesPct, spoNoPct: recomputed.noPct,
      ccYesPct: 100, ccNoPct: 0,
      spoYes: 6, spoNo: 4, spoAbstain: 0,
      ccYes: 5, ccNo: 0, ccAbstain: 0,
      spoEligiblePower: 1000,
    });
    const result = overviewRowVoting(a, { drepStakeTotal: 1_000_000, committeeSize: 5 });

    expect(result.bodies.map((b) => b.body)).toEqual(['DRep', 'SPO', 'CC']);
    expect(result.absentBodies).toEqual([]);

    const spo = result.bodies[1];
    expect(spo.composition?.yes).toBe(recomputed.yesPct);

    const drep = result.bodies[0];
    expect(drep.composition).toBeNull(); // bootstrap: no DRep pct synced
  });

  it('SPO participation is null when spoEligiblePower is null', () => {
    const a = makeRow({
      type: 'InfoAction',
      spoYesPower: 10, spoNoPower: 5, spoAbstainPower: 0,
      spoEligiblePower: null,
    });
    const result = overviewRowVoting(a, { drepStakeTotal: 1000, committeeSize: 5 });
    const spo = result.bodies.find((b) => b.body === 'SPO')!;
    expect(spo.participation).toBeNull();
  });

  it('security-relevant parameter change: SPO is eligible even with zero cast votes', () => {
    const a = makeRow({
      type: 'ParameterChange',
      drepYesPct: 40, drepNoPct: 10,
      ccYesPct: 100, ccNoPct: 0,
      spoYesPower: 0, spoNoPower: 0, spoAbstainPower: 0,
      spoEligiblePower: 1000,
    });
    const result = overviewRowVoting(a, { drepStakeTotal: 1_000_000, committeeSize: 5 }, { paramTouchesSecurity: true });

    expect(result.bodies.map((b) => b.body)).toEqual(['DRep', 'SPO', 'CC']);
    expect(result.absentBodies).toEqual([]);
    const spo = result.bodies.find((b) => b.body === 'SPO')!;
    expect(spo.composition).toBeNull(); // no spoYesPct yet, but still an eligible body
    expect(spo.participation).toBe(0);
  });

  it('non-security parameter change: SPO stays absent with zero cast votes', () => {
    const a = makeRow({
      type: 'ParameterChange',
      drepYesPct: 40, drepNoPct: 10,
      ccYesPct: 100, ccNoPct: 0,
      spoYesPower: 0, spoNoPower: 0, spoAbstainPower: 0,
      spoEligiblePower: 1000,
    });
    const result = overviewRowVoting(a, { drepStakeTotal: 1_000_000, committeeSize: 5 }, { paramTouchesSecurity: false });

    expect(result.bodies.map((b) => b.body)).toEqual(['DRep', 'CC']);
    expect(result.absentBodies).toEqual(['SPO']);
  });
});

describe('headlineComposition', () => {
  it('threshold type: leads with the DRep yes-of-eligible share', () => {
    const h = headlineComposition({ type: 'TreasuryWithdrawals', drepYesPct: 74.53, drepNoPct: 25.47 } as any);
    expect(h?.role).toBe('DRep');
    expect(h!.yesPct).toBeCloseTo(74.53, 5);
  });

  it('hard fork is SPO-led: picks the SPO share', () => {
    const h = headlineComposition({ type: 'HardForkInitiation', spoYesPct: 65, spoNoPct: 35, drepYesPct: null, drepNoPct: null } as any);
    expect(h?.role).toBe('SPO');
    expect(h!.yesPct).toBe(65);
  });

  it('returns null when no body has a synced tally', () => {
    expect(headlineComposition({ type: 'InfoAction' } as any)).toBeNull();
  });
});

describe('fmtPctFine', () => {
  it('keeps one decimal so a small ratification share is not rounded up (6.84 -> 6.8%, not 7%)', () => {
    expect(fmtPctFine(6.84)).toBe('6.8%');
    expect(fmtPctFine(0.4)).toBe('0.40%');
    expect(fmtPctFine(66.666)).toBe('66.7%');
    expect(fmtPctFine(100)).toBe('100%');
    expect(fmtPctFine(0)).toBe('0%');
  });
});

describe('compositionBar', () => {
  it('returns null before any tally has synced (yesPct null)', () => {
    expect(
      compositionBar({ yesPct: null, yesStake: null, noStake: null, abstainStake: null, eligible: null }),
    ).toBeNull();
  });

  it('pins Yes to the stored pct and splits the rest into No / Not voted by stake', () => {
    // 5.33B eligible, 364.6M yes (6.84%), 479.6M no; the huge remainder never voted.
    const bar = compositionBar({
      yesPct: 6.84,
      yesStake: 364_600_000,
      noStake: 479_600_000,
      abstainStake: 0,
      eligible: 5_330_000_000,
    })!;
    expect(bar.yes).toBeCloseTo(6.84, 5);
    expect(bar.splitKnown).toBe(true);
    // Segments sum to 100, and Not voted dominates (the silent majority).
    expect(bar.yes + bar.no + bar.notVoted).toBeCloseTo(100, 5);
    expect(bar.notVoted).toBeGreaterThan(80);
    // No is far smaller than Not voted, so the bar never reads as an opposition wall.
    expect(bar.no).toBeLessThan(bar.notVoted);
  });

  it('never renders the SPO 100%-yes illusion: one yes voter is a sliver, not a full bar', () => {
    const bar = compositionBar({
      yesPct: 0.4,
      yesStake: 44_000_000,
      noStake: 0,
      abstainStake: 0,
      eligible: 11_020_000_000,
    })!;
    expect(bar.yes).toBeCloseTo(0.4, 5);
    expect(bar.no).toBe(0);
    expect(bar.notVoted).toBeCloseTo(99.6, 5);
  });

  it('excludes abstain from the denominator', () => {
    // Everyone eligible either voted yes or abstained; with abstain removed, yes fills
    // the whole (non-abstain) denominator, so nothing is left for No / Not voted.
    const bar = compositionBar({
      yesPct: 100,
      yesStake: 500,
      noStake: 0,
      abstainStake: 500,
      eligible: 1000,
    })!;
    expect(bar.yes).toBe(100);
    expect(bar.no).toBe(0);
    expect(bar.notVoted).toBe(0);
  });

  it('cannot split without an eligible denominator: remainder is Not voted, never No', () => {
    const bar = compositionBar({
      yesPct: 30,
      yesStake: 300,
      noStake: 200,
      abstainStake: 0,
      eligible: null,
    })!;
    expect(bar.splitKnown).toBe(false);
    expect(bar.no).toBe(0);
    expect(bar.notVoted).toBe(70);
  });
});

describe('bodyComposition / compositionAmounts', () => {
  const makeRow = (over: Partial<RowVotingInput>): RowVotingInput => ({
    type: 'InfoAction',
    drepYesPct: null, drepNoPct: null,
    spoYesPct: null, spoNoPct: null,
    ccYesPct: null, ccNoPct: null,
    drepYes: null, drepNo: null, drepAbstain: null,
    spoYes: null, spoNo: null, spoAbstain: null,
    ccYes: null, ccNo: null, ccAbstain: null,
    drepYesPower: null, drepNoPower: null, drepAbstainPower: null,
    spoYesPower: null, spoNoPower: null, spoAbstainPower: null,
    drepVotedPower: null,
    spoEligiblePower: null,
    ...over,
  });

  it('DRep composition uses the total active DRep stake as the denominator', () => {
    const a = makeRow({
      drepYesPct: 6.84,
      drepYesPower: 364_600_000, drepNoPower: 479_600_000, drepAbstainPower: 0,
      drepVotedPower: 844_200_000,
    });
    const bar = bodyComposition(a, 'DRep', { drepStakeTotal: 5_330_000_000, committeeSize: null })!;
    expect(bar.yes).toBeCloseTo(6.84, 5);
    expect(bar.notVoted).toBeGreaterThan(80);
  });

  it('CC composition uses the committee seat count as the denominator', () => {
    const a = makeRow({ ccYesPct: 80, ccYes: 4, ccNo: 1, ccAbstain: 0 });
    const bar = bodyComposition(a, 'CC', { drepStakeTotal: null, committeeSize: 7 })!;
    expect(bar.yes).toBe(80);
    // 2 of 7 seats silent -> Not voted present, No the smaller slice.
    expect(bar.notVoted).toBeGreaterThan(0);
    expect(bar.no).toBeGreaterThan(0);
  });

  it('formats Not voted from the un-voted eligible stake and flags abstain', () => {
    const a = makeRow({
      drepYesPower: 364_600_000_000_000, drepNoPower: 479_600_000_000_000, drepAbstainPower: 31_500_000_000_000,
      drepVotedPower: 875_700_000_000_000,
    });
    const amounts = compositionAmounts(a, 'DRep', { drepStakeTotal: 5_330_000_000_000_000, committeeSize: null })!;
    expect(amounts.notVoted).not.toBe('n/a');
    expect(amounts.hasAbstain).toBe(true);
  });
});

describe('absentBodyNote', () => {
  it('names the body that cannot vote on a treasury withdrawal', () => {
    expect(absentBodyNote({ type: 'TreasuryWithdrawals' } as any)).toBe(
      'SPOs do not vote on treasury withdrawals',
    );
  });

  it('is null for info actions (every body can vote)', () => {
    expect(absentBodyNote({ type: 'InfoAction' } as any)).toBeNull();
  });

  it('drops the SPO note for a security-relevant parameter change', () => {
    expect(absentBodyNote({ type: 'ParameterChange' } as any)).toBe(
      'SPOs do not vote on parameter change',
    );
    expect(
      absentBodyNote({ type: 'ParameterChange' } as any, { paramTouchesSecurity: true }),
    ).toBeNull();
  });
});
