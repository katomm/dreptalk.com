import { describe, expect, it } from 'vitest';
import { drepGroupsAvailable } from './gate.js';
import { credentialForDrepId, drepIdForCredential, groupIdentSeed, groupIdForms, groupIdParam, groupIdString } from './ids.js';
import { encodeBech32 } from '../crypto/bech32.js';
import { hexToBytes } from '../crypto/hex.js';

describe('drepGroupsAvailable', () => {
  it('is true on preprod and mainnet', () => {
    expect(drepGroupsAvailable('preprod')).toBe(true);
    expect(drepGroupsAvailable('mainnet')).toBe(true);
    expect(drepGroupsAvailable('mainnet', ['preprod'])).toBe(false);
    expect(drepGroupsAvailable(undefined)).toBe(false);
  });
});

describe('drep ids', () => {
  it('round trips key and script credentials with a drep1 prefix', () => {
    for (const c of [
      { kind: 'key', hash: '11'.repeat(28) },
      { kind: 'script', hash: '22'.repeat(28) },
    ] as const) {
      const id = drepIdForCredential(c);
      expect(id.startsWith('drep1')).toBe(true);
      expect(credentialForDrepId(id)).toEqual(c);
    }
  });
  it('returns null for garbage', () => {
    expect(credentialForDrepId('nope')).toBeNull();
  });
});

describe('group ids', () => {
  const ref = { txHash: 'ab'.repeat(32), index: 3 };
  it('round trips and accepts uppercase input', () => {
    const s = groupIdString(ref);
    expect(groupIdParam(s)).toEqual(ref);
    expect(groupIdParam(s.toUpperCase())).toEqual(ref);
  });
  it('reads the legacy group1 form as the same id', () => {
    expect(groupIdString(ref).startsWith('drep_group1')).toBe(true);
    const bytes = new Uint8Array(34);
    bytes.set(hexToBytes(ref.txHash), 0);
    bytes[33] = ref.index;
    expect(groupIdParam(encodeBech32('group', bytes))).toEqual(ref);
    expect(groupIdParam(encodeBech32('pool', bytes))).toBeNull();
  });
  it('returns null for garbage and undefined', () => {
    expect(groupIdParam('group1xyz')).toBeNull();
    expect(groupIdParam(undefined)).toBeNull();
  });
});

describe('one byte group ids and their old forms', () => {
  const ref = { txHash: '3140fac3858a1a0672dfb42a77a9b749d52f49e79c2fe042637b32f36d07058b', index: 0 };
  const CURRENT = 'drep_group1x9q04su93gdqvuklks4802dhf82j7j08nsh7qsnr0ve0xmg8qk9sqpwk7pe';
  const OLD_DREP_GROUP = 'drep_group1x9q04su93gdqvuklks4802dhf82j7j08nsh7qsnr0ve0xmg8qk9sqqqmcftfd';
  const twoByte = (prefix: string, index: number): string => {
    const bytes = new Uint8Array(34);
    bytes.set(hexToBytes(ref.txHash), 0);
    bytes[32] = index >> 8;
    bytes[33] = index & 0xff;
    return encodeBech32(prefix, bytes);
  };

  it('writes the 33 byte form and reads all three forms as the same ref', () => {
    expect(groupIdString(ref)).toBe(CURRENT);
    expect(twoByte('drep_group', 0)).toBe(OLD_DREP_GROUP);
    expect(groupIdParam(CURRENT)).toEqual(ref);
    expect(groupIdParam(OLD_DREP_GROUP)).toEqual(ref);
    expect(groupIdParam(twoByte('group', 0))).toEqual(ref);
  });

  it('reads a 34 byte form with an index above 255 as no group', () => {
    expect(groupIdParam(twoByte('drep_group', 300))).toBeNull();
    expect(groupIdParam(twoByte('group', 300))).toBeNull();
    expect(groupIdParam(twoByte('drep_group', 255))).toEqual({ ...ref, index: 255 });
  });

  it('lists the current form and both old forms', () => {
    const forms = groupIdForms(ref);
    expect(forms).toEqual([CURRENT, OLD_DREP_GROUP, twoByte('group', 0)]);
    expect(new Set(forms).size).toBe(3);
  });

  it('seeds the identicon with the output reference', () => {
    expect(groupIdentSeed(ref)).toBe(`${ref.txHash}#0`);
  });
});
