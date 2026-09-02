import { describe, it, expect } from 'vitest';
import { delegationStartEpoch } from './delegationStart.js';
import type { AccountUpdateHistoryRow } from '../koios/client.js';

const row = (action: string, epoch: number, slot: number): AccountUpdateHistoryRow => ({
  stake_address: 'stake_test1x',
  action_type: action,
  tx_hash: `${action}-${slot}`,
  epoch_no: epoch,
  absolute_slot: slot,
});

describe('delegationStartEpoch', () => {
  it('returns null for an empty history', () => {
    expect(delegationStartEpoch([])).toBe(null);
  });

  it('returns null when the account has no delegation_drep event', () => {
    const rows = [row('registration', 600, 10), row('delegation_pool', 610, 20), row('withdrawal', 620, 30)];
    expect(delegationStartEpoch(rows)).toBe(null);
  });

  it('picks the epoch of the latest delegation_drep event by absolute_slot', () => {
    const rows = [
      row('delegation_drep', 640, 10),
      row('delegation_drep', 655, 90),
      row('delegation_drep', 648, 50),
    ];
    expect(delegationStartEpoch(rows)).toBe(655);
  });

  it('ignores later events of other action types', () => {
    const rows = [
      row('delegation_drep', 640, 10),
      row('delegation_pool', 700, 999),
      row('withdrawal', 701, 1000),
    ];
    expect(delegationStartEpoch(rows)).toBe(640);
  });

  it('breaks a slot tie on the higher epoch_no', () => {
    const rows = [row('delegation_drep', 640, 77), row('delegation_drep', 641, 77)];
    expect(delegationStartEpoch(rows)).toBe(641);
  });

  it('reads the newest event even when the history arrives unsorted', () => {
    const rows = [
      row('registration', 600, 5),
      row('delegation_drep', 660, 120),
      row('delegation_pool', 661, 130),
      row('delegation_drep', 650, 100),
    ];
    expect(delegationStartEpoch(rows)).toBe(660);
  });
});
