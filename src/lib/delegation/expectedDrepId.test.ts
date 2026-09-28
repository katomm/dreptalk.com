import { describe, it, expect } from 'vitest';
import { normalizeExpectedDrepId } from './expectedDrepId.js';
import { drepIdFromKeyHash, DREP_SCRIPT_HEADER } from '../cardano/identity.js';
import { encodeBech32 } from '../crypto/bech32.js';

// Both forms of the SAME credential, built the way identity.test.ts builds them,
// so the pair is a real conversion and not two invented strings.
const HASH = new Uint8Array(28).fill(0x42);
const CIP105 = encodeBech32('drep_vkh', HASH);
const CIP129 = drepIdFromKeyHash(HASH);

const SCRIPT_PAYLOAD = new Uint8Array(29);
SCRIPT_PAYLOAD[0] = DREP_SCRIPT_HEADER;
SCRIPT_PAYLOAD.set(new Uint8Array(28).fill(0x7f), 1);
const SCRIPT_CIP129 = encodeBech32('drep', SCRIPT_PAYLOAD);

describe('normalizeExpectedDrepId', () => {
  it('converts a CIP-105 id to the stored CIP-129 form', () => {
    expect(normalizeExpectedDrepId(CIP105)).toBe(CIP129);
  });

  it('leaves a CIP-129 id unchanged', () => {
    expect(normalizeExpectedDrepId(CIP129)).toBe(CIP129);
  });

  it('keeps a script credential', () => {
    expect(normalizeExpectedDrepId(SCRIPT_CIP129)).toBe(SCRIPT_CIP129);
  });

  it('rejects anything that is not a DRep id', () => {
    expect(normalizeExpectedDrepId('drep1notreal')).toBeNull();
    expect(normalizeExpectedDrepId('')).toBeNull();
    expect(normalizeExpectedDrepId('stake1u0abc')).toBeNull();
  });
});
