import { describe, it, expect } from 'vitest';
import { detectIdentifier } from './identifiers.js';
import { encodeBech32 } from '../crypto/bech32.js';

const HASH = 'a'.repeat(64);

describe('detectIdentifier', () => {
  it('detects a bech32 governance action id', () => {
    expect(detectIdentifier('gov_action1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn')).toEqual({
      kind: 'gov-action',
      by: 'proposal_id',
      value: 'gov_action1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn',
    });
  });

  it('lowercases pasted uppercase identifiers', () => {
    expect(detectIdentifier('GOV_ACTION1ABC')).toEqual({
      kind: 'gov-action',
      by: 'proposal_id',
      value: 'gov_action1abc',
    });
  });

  it('detects a tx hash with and without an index', () => {
    expect(detectIdentifier(`${HASH}#2`)).toEqual({ kind: 'gov-action', by: 'id', value: `${HASH}#2` });
    expect(detectIdentifier(HASH)).toEqual({ kind: 'gov-action', by: 'id-prefix', value: `${HASH}#` });
  });

  it('detects a CIP-129 hex governance action id (explorer.cardano.org form)', () => {
    // txHash + index as hex bytes, no '#'. 1-byte index: 0a = 10.
    expect(detectIdentifier(`${HASH}0a`)).toEqual({ kind: 'gov-action', by: 'id', value: `${HASH}#10` });
    expect(detectIdentifier(`${HASH}00`)).toEqual({ kind: 'gov-action', by: 'id', value: `${HASH}#0` });
    // Multi-byte index still decodes: 0100 hex = 256.
    expect(detectIdentifier(`${HASH}0100`)).toEqual({ kind: 'gov-action', by: 'id', value: `${HASH}#256` });
  });

  it('does not treat a bare hash or an odd-length hex tail as a CIP-129 id', () => {
    // Exactly 64 hex stays an id-prefix; 65 hex (odd tail) is not a byte index.
    expect(detectIdentifier(HASH)).toEqual({ kind: 'gov-action', by: 'id-prefix', value: `${HASH}#` });
    expect(detectIdentifier(`${HASH}a`)).toBeNull();
  });

  it('detects drep and drep_script ids', () => {
    expect(detectIdentifier('drep1abcdef')).toEqual({ kind: 'drep', drepId: 'drep1abcdef' });
    expect(detectIdentifier('drep_script1abcdef')).toEqual({ kind: 'drep', drepId: 'drep_script1abcdef' });
  });

  it('returns null for ordinary search terms', () => {
    expect(detectIdentifier('treasury withdrawal')).toBeNull();
    expect(detectIdentifier('drep')).toBeNull();
    expect(detectIdentifier('deadbeef')).toBeNull();
  });

  it('returns null for a tx hash with an absurdly large index', () => {
    expect(detectIdentifier(`${HASH}#${'9'.repeat(30)}`)).toBeNull();
  });
});

describe('detectIdentifier pool ids', () => {
  const poolId = encodeBech32('pool', new Uint8Array(28).fill(7));

  it('detects a checksum-valid pool id, also pasted in upper case', () => {
    expect(detectIdentifier(poolId)).toEqual({ kind: 'pool', poolId });
    expect(detectIdentifier(poolId.toUpperCase())).toEqual({ kind: 'pool', poolId });
  });

  it('rejects a pool id with a broken checksum or a wrong payload length', () => {
    const broken = `${poolId.slice(0, -1)}${poolId.endsWith('q') ? 'p' : 'q'}`;
    expect(detectIdentifier(broken)).toBeNull();
    expect(detectIdentifier(encodeBech32('pool', new Uint8Array(20)))).toBeNull();
  });
});
