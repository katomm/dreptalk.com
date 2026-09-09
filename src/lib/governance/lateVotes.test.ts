import { describe, it, expect } from 'vitest';
import { lateVoterIds } from './lateVotes.js';
import { epochStartUnix, resolveNetwork } from '../config/network.js';

const cfg = resolveNetwork('mainnet');
// A vote comfortably inside epoch N, and one at the very start of epoch N.
const midEpoch = (e: number) => epochStartUnix(e, cfg) + 3600;
const startEpoch = (e: number) => epochStartUnix(e, cfg);

describe('lateVoterIds', () => {
  const ratified = { status: 'ratified', decidedEpoch: 640, ratifiedEpoch: 640 };

  it('flags votes cast in or after the ratification epoch', () => {
    const voters = [
      { voter_id: 'onTime', block_time: midEpoch(639) },
      { voter_id: 'late', block_time: midEpoch(640) },
      { voter_id: 'boundary', block_time: startEpoch(640) },
      { voter_id: 'later', block_time: midEpoch(641) },
    ];
    const late = lateVoterIds(voters, ratified, 'mainnet');
    expect(late.has('late')).toBe(true);
    expect(late.has('boundary')).toBe(true);
    expect(late.has('later')).toBe(true);
    expect(late.has('onTime')).toBe(false);
  });

  it('ignores votes with unknown block time', () => {
    const late = lateVoterIds([{ voter_id: 'x', block_time: null }], ratified, 'mainnet');
    expect(late.size).toBe(0);
  });

  it('falls back to decided_epoch only while ratified, never for enacted', () => {
    const voters = [{ voter_id: 'late', block_time: midEpoch(645) }];
    expect(lateVoterIds(voters, { status: 'enacted', decidedEpoch: 640, ratifiedEpoch: null }, 'mainnet').size).toBe(0);
    expect(lateVoterIds(voters, { status: 'expired', decidedEpoch: 640, ratifiedEpoch: null }, 'mainnet').size).toBe(0);
    expect(lateVoterIds(voters, { status: 'active', decidedEpoch: null, ratifiedEpoch: null }, 'mainnet').size).toBe(0);
  });

  // Migration 0093 records the ratification epoch separately, so an action that
  // moved on to 'enacted' still knows when its tally froze. The same vote must
  // keep its marker across that transition.
  it('keeps the same verdict across ratified -> enacted when ratified_epoch is known', () => {
    const voters = [
      { voter_id: 'onTime', block_time: midEpoch(639) },
      { voter_id: 'late', block_time: midEpoch(640) },
    ];
    const asRatified = lateVoterIds(voters, { status: 'ratified', decidedEpoch: 640, ratifiedEpoch: 640 }, 'mainnet');
    // decided_epoch has moved on to the enacted epoch, ratified_epoch has not.
    const asEnacted = lateVoterIds(voters, { status: 'enacted', decidedEpoch: 642, ratifiedEpoch: 640 }, 'mainnet');
    expect([...asEnacted]).toEqual([...asRatified]);
    expect(asEnacted.has('late')).toBe(true);
    expect(asEnacted.has('onTime')).toBe(false);
  });

  it('prefers ratified_epoch over decided_epoch while still ratified', () => {
    const voters = [{ voter_id: 'v', block_time: midEpoch(641) }];
    expect(lateVoterIds(voters, { status: 'ratified', decidedEpoch: 645, ratifiedEpoch: 642 }, 'mainnet').size).toBe(0);
  });

  it('marks nothing for a terminal action that was never ratified', () => {
    const voters = [{ voter_id: 'v', block_time: midEpoch(645) }];
    expect(lateVoterIds(voters, { status: 'expired', decidedEpoch: 640, ratifiedEpoch: null }, 'mainnet').size).toBe(0);
  });
});
