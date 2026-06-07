import { describe, it, expect } from 'vitest';
import {
  readableType,
  formatAda,
  statusBadge,
  epochCountdown,
  tallyBar,
  voteTone,
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
  it('maps known statuses to tones', () => {
    expect(statusBadge('active').tone).toBe('active');
    expect(statusBadge('enacted').tone).toBe('positive');
    expect(statusBadge('ratified').tone).toBe('positive');
    expect(statusBadge('dropped').tone).toBe('negative');
    expect(statusBadge('expired').tone).toBe('neutral');
  });
  it('capitalizes an unknown status', () => {
    expect(statusBadge('weird')).toEqual({ label: 'Weird', tone: 'neutral' });
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

describe('tallyBar', () => {
  it('derives abstain as the remainder and clamps', () => {
    expect(tallyBar(0.01, 99.99)).toEqual({ yes: 0.01, no: 99.99, abstain: 0 });
    expect(tallyBar(30, 20)).toEqual({ yes: 30, no: 20, abstain: 50 });
  });
  it('returns null when no tally exists', () => {
    expect(tallyBar(null, null)).toBeNull();
  });
});

describe('voteTone', () => {
  it('maps votes to tones case-insensitively', () => {
    expect(voteTone('Yes')).toBe('positive');
    expect(voteTone('no')).toBe('negative');
    expect(voteTone('Abstain')).toBe('neutral');
  });
});
