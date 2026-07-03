import { describe, it, expect } from 'vitest';
import { lateVoterIds } from './lateVotes.js';
import { epochStartUnix, resolveNetwork } from '../config/network.js';

const cfg = resolveNetwork('mainnet');
// A vote comfortably inside epoch N, and one at the very start of epoch N.
const midEpoch = (e: number) => epochStartUnix(e, cfg) + 3600;
const startEpoch = (e: number) => epochStartUnix(e, cfg);

describe('lateVoterIds', () => {
  const ratified = { status: 'ratified', decidedEpoch: 640 };

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

  it('returns empty for non-ratified actions (avoids misclassifying enacted)', () => {
    const voters = [{ voter_id: 'late', block_time: midEpoch(645) }];
    expect(lateVoterIds(voters, { status: 'enacted', decidedEpoch: 640 }, 'mainnet').size).toBe(0);
    expect(lateVoterIds(voters, { status: 'expired', decidedEpoch: 640 }, 'mainnet').size).toBe(0);
    expect(lateVoterIds(voters, { status: 'active', decidedEpoch: null }, 'mainnet').size).toBe(0);
  });
});
