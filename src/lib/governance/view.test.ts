import { describe, it, expect } from 'vitest';
import {
  readableType,
  formatAda,
  statusBadge,
  isTerminalStatus,
  epochCountdown,
  epochDaysLeft,
  tallyBar,
  voteTone,
  fmtPct,
  formatAdaShort,
  stakeParticipation,
  formatEpochDate,
  govTypeTone,
} from './view.js';

describe('readableType / formatAda', () => {
  it('spaces camelCase types', () => {
    expect(readableType('TreasuryWithdrawals')).toBe('Treasury Withdrawals');
  });
  it('formats lovelace to ADA, null on garbage', () => {
    expect(formatAda('100000000000')).toBe('100,000 ADA');
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
});

describe('epochCountdown', () => {
  it('estimates days for a future expiry', () => {
    expect(epochCountdown(294, 290)).toBe('~20 days left (epoch 294)');
  });
  it('returns null when past or unknown', () => {
    expect(epochCountdown(290, 290)).toBeNull();
    expect(epochCountdown(290, 295)).toBeNull();
    expect(epochCountdown(null, 290)).toBeNull();
    expect(epochCountdown(294, null)).toBeNull();
  });
});

describe('epochDaysLeft', () => {
  it('returns whole days to a future expiry, null when past or unknown', () => {
    expect(epochDaysLeft(294, 290)).toBe(20);
    expect(epochDaysLeft(290, 290)).toBeNull();
    expect(epochDaysLeft(290, 295)).toBeNull();
    expect(epochDaysLeft(null, 290)).toBeNull();
    expect(epochDaysLeft(294, null)).toBeNull();
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

describe('voteTone', () => {
  it('maps votes to tones case-insensitively', () => {
    expect(voteTone('Yes')).toBe('positive');
    expect(voteTone('no')).toBe('negative');
    expect(voteTone('Abstain')).toBe('neutral');
  });
});

describe('stakeParticipation / formatAdaShort', () => {
  it('formatAdaShort rounds lovelace to B/M/K ADA', () => {
    expect(formatAdaShort(3_210_000_000_000_000)).toBe('3.21B ₳');
    expect(formatAdaShort(1_840_000_000_000_000)).toBe('1.84B ₳');
    expect(formatAdaShort(12_400_000_000_000)).toBe('12.4M ₳');   // M branch
    expect(formatAdaShort(950_000_000_000)).toBe('950K ₳');        // K branch
    expect(formatAdaShort(0)).toBe('0 ₳');
  });

  it('stakeParticipation returns pct + parts, null when total is 0', () => {
    expect(stakeParticipation(0, 0)).toBeNull();
    const s = stakeParticipation(3_210_000_000_000_000, 6_660_000_000_000_000)!;
    expect(s.pct).toBeCloseTo(48.2, 1);
    expect(s.votedLabel).toBe('3.21B ₳');
    expect(s.totalLabel).toBe('6.66B ₳');
  });
});
