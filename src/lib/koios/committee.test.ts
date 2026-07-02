import { describe, it, expect } from 'vitest';
import { activeCommitteeSize } from './committee.js';
import type { CommitteeMember } from './client.js';

function member(over: Partial<CommitteeMember> = {}): CommitteeMember {
  return {
    status: 'authorized',
    cc_hot_id: null,
    cc_cold_id: null,
    cc_hot_hex: null,
    cc_cold_hex: null,
    expiration_epoch: null,
    cc_hot_has_script: null,
    cc_cold_has_script: null,
    ...over,
  };
}

describe('activeCommitteeSize', () => {
  it('counts authorized members and ignores resigned ones', () => {
    const members = [
      ...Array.from({ length: 7 }, () => member({ expiration_epoch: 700 })),
      member({ status: 'resigned', expiration_epoch: 700 }),
    ];
    expect(activeCommitteeSize(members, 640)).toBe(7);
  });

  it('excludes members whose term has expired', () => {
    const members = [
      member({ expiration_epoch: 639 }), // expired before epoch 640
      member({ expiration_epoch: 640 }), // still active during its expiry epoch
    ];
    expect(activeCommitteeSize(members, 640)).toBe(1);
  });

  it('keeps members with no expiration epoch', () => {
    expect(activeCommitteeSize([member({ expiration_epoch: null })], 640)).toBe(1);
  });

  it('skips the expiry check when the current epoch is unknown', () => {
    expect(activeCommitteeSize([member({ expiration_epoch: 1 })], null)).toBe(1);
  });

  it('returns 0 for an empty committee', () => {
    expect(activeCommitteeSize([], 640)).toBe(0);
  });
});
