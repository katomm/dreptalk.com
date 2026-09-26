import { describe, it, expect } from 'vitest';
import { RESERVED_HANDLES } from './drepLinkReserved.js';

describe('RESERVED_HANDLES', () => {
  it('holds only valid handle shapes, so a reserved entry can never be unreachable', () => {
    for (const h of RESERVED_HANDLES) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it('reserves the two organisations that exist as real DReps', () => {
    expect(RESERVED_HANDLES.has('cardano-foundation')).toBe(true);
    expect(RESERVED_HANDLES.has('emurgo')).toBe(true);
  });
});
