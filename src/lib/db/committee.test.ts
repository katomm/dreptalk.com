import { describe, expect, it } from 'vitest';
import { committeeReferenceForAction } from './committee.js';

describe('committeeReferenceForAction', () => {
  it('judges a ratified or enacted action at the boundary that opens its ratified epoch', () => {
    expect(committeeReferenceForAction({ status: 'enacted', decidedEpoch: 598, ratifiedEpoch: 597 }, 700)).toEqual({ kind: 'boundary', epoch: 597 });
    expect(committeeReferenceForAction({ status: 'ratified', decidedEpoch: 597, ratifiedEpoch: 597 }, 700)).toEqual({ kind: 'boundary', epoch: 597 });
  });

  it('derives the boundary of a pre-0093 enacted row from its enactment epoch', () => {
    expect(committeeReferenceForAction({ status: 'enacted', decidedEpoch: 638 }, 700)).toEqual({ kind: 'boundary', epoch: 637 });
  });

  it('judges an expired action at the boundary that opens its expiry epoch', () => {
    expect(committeeReferenceForAction({ status: 'expired', decidedEpoch: 581, expiryEpoch: 581 }, 700)).toEqual({ kind: 'boundary', epoch: 581 });
    expect(committeeReferenceForAction({ status: 'expired', decidedEpoch: 546 }, 700)).toEqual({ kind: 'boundary', epoch: 546 });
  });

  it('judges a closed or dropped action at its decided epoch', () => {
    expect(committeeReferenceForAction({ status: 'closed', decidedEpoch: 529 }, 700)).toEqual({ kind: 'boundary', epoch: 529 });
    expect(committeeReferenceForAction({ status: 'dropped', decidedEpoch: 614 }, 700)).toEqual({ kind: 'boundary', epoch: 614 });
  });

  it('observes an open action at the current epoch', () => {
    expect(committeeReferenceForAction({ status: 'active', decidedEpoch: null }, 700)).toEqual({ kind: 'observed', epoch: 700 });
  });

  it('is null when nothing places the committee in time', () => {
    expect(committeeReferenceForAction({ status: 'active', decidedEpoch: null }, null)).toBeNull();
    expect(committeeReferenceForAction({ status: 'enacted', decidedEpoch: null }, 700)).toBeNull();
  });
});
