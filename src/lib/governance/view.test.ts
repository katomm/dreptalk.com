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
  stakeParticipation,
  formatEpochDate,
  govTypeTone,
  govActionOgImage,
  threadOgImage,
  isSpoLedType,
  overviewTally,
  sentimentSubline,
  bodyVoteAmounts,
  advisoryBodyTallies,
  TERMINAL_STATUSES,
  type RoleTallyInput,
  type BodyVoteInput,
} from './view.js';

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

describe('stakeParticipation', () => {
  it('stakeParticipation returns pct + parts, null when total is 0', () => {
    expect(stakeParticipation(0, 0)).toBeNull();
    const s = stakeParticipation(3_210_000_000_000_000, 6_660_000_000_000_000)!;
    expect(s.pct).toBeCloseTo(48.2, 1);
    expect(s.votedLabel).toBe('3.21B ₳');
    expect(s.totalLabel).toBe('6.66B ₳');
  });
});

// Minimal RoleTallyInput builder: empty tallies, overridable per role. Shared by
// the overviewTally and sentimentSubline suites below.
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

describe('sentimentSubline', () => {
  it('reads the no-share as "not yet voted" when it is only non-voting stake', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', status: 'active', spoYesPct: 16, spoNoPct: 84, spoYes: 68, spoNo: 0, spoAbstain: 0 }))!;
    expect(sentimentSubline(t)).toBe('84% not yet voted');
  });
  it('keeps an abstain share alongside "not yet voted"', () => {
    const t = overviewTally(make({ type: 'HardForkInitiation', status: 'active', spoYesPct: 16, spoNoPct: 74, spoYes: 68, spoNo: 0, spoAbstain: 1 }))!;
    expect(sentimentSubline(t)).toBe('74% not yet voted · 10% abstain');
  });
  it('reads as "against" for a normal tally', () => {
    const t = overviewTally(make({ type: 'TreasuryWithdrawals', status: 'active', drepYesPct: 79, drepNoPct: 21, drepYes: 200, drepNo: 70, drepAbstain: 6 }))!;
    expect(sentimentSubline(t)).toBe('21% against · 0% abstain');
  });
});

describe('bodyVoteAmounts', () => {
  const a: BodyVoteInput = {
    drepYesPower: 104_420_000_000_000, drepNoPower: 565_310_000_000_000, drepAbstainPower: 175_830_000_000_000,
    spoYesPower: null, spoNoPower: null, spoAbstainPower: null,
    ccYes: 4, ccNo: 0, ccAbstain: 1,
  };

  it('formats DRep amounts as compact ADA from the per-option power', () => {
    expect(bodyVoteAmounts(a, 'DRep')).toEqual({ yes: '104.4M ₳', no: '565.3M ₳', abstain: '175.8M ₳' });
  });

  it('renders CC amounts as plain member counts, not ADA', () => {
    expect(bodyVoteAmounts(a, 'CC')).toEqual({ yes: '4', no: '0', abstain: '1' });
  });

  it('returns null for a body with no power data', () => {
    expect(bodyVoteAmounts(a, 'SPO')).toBeNull();
  });

  it('treats a present-but-zero option as 0, not absent', () => {
    expect(bodyVoteAmounts({ ...a, drepYesPower: 0, drepNoPower: null, drepAbstainPower: null }, 'DRep')).toEqual({
      yes: '0 ₳', no: '0 ₳', abstain: '0 ₳',
    });
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

describe('advisoryBodyTallies', () => {
  // Minimal input: all per-body pct + power/count fields. Values chosen so each body
  // has a distinct, checkable bar and amounts.
  const base = {
    drepYesPct: 60, drepNoPct: 10,
    spoYesPct: 40, spoNoPct: 40,
    ccYesPct: 100, ccNoPct: 0,
    drepYesPower: 6_000_000_000, drepNoPower: 1_000_000_000, drepAbstainPower: 3_000_000_000,
    spoYesPower: 4_000_000_000, spoNoPower: 4_000_000_000, spoAbstainPower: 2_000_000_000,
    ccYes: 5, ccNo: 0, ccAbstain: 1,
  };

  it('returns exactly DRep, SPO, CC in that fixed order', () => {
    expect(advisoryBodyTallies(base).map((r) => r.body)).toEqual(['DRep', 'SPO', 'CC']);
  });

  it('gives each body a human label', () => {
    const byBody = Object.fromEntries(advisoryBodyTallies(base).map((r) => [r.body, r.label]));
    expect(byBody.DRep).toBe('DReps');
    expect(byBody.SPO).toBe('SPOs');
    expect(byBody.CC).toBe('Constitutional Committee');
  });

  it('builds each body bar from its own yes/no percentages, abstain as remainder', () => {
    const rows = advisoryBodyTallies(base);
    expect(rows[0].bar).toEqual({ yes: 60, no: 10, abstain: 30 });
    expect(rows[1].bar).toEqual({ yes: 40, no: 40, abstain: 20 });
    expect(rows[2].bar).toEqual({ yes: 100, no: 0, abstain: 0 });
  });

  it('carries per-body amounts (ADA for DRep/SPO, counts for CC)', () => {
    const rows = advisoryBodyTallies(base);
    expect(rows[2].amounts).toEqual({ yes: '5', no: '0', abstain: '1' });
    // DRep amounts are compact ADA strings, not raw lovelace.
    expect(rows[0].amounts?.yes).not.toBe('6000000000');
  });

  it('still returns all three bodies when a body has no synced tally', () => {
    const rows = advisoryBodyTallies({
      ...base,
      spoYesPct: null, spoNoPct: null,
      spoYesPower: null, spoNoPower: null, spoAbstainPower: null,
    });
    expect(rows.map((r) => r.body)).toEqual(['DRep', 'SPO', 'CC']);
    expect(rows[1].bar).toBeNull();
    expect(rows[1].amounts).toBeNull();
  });
});
