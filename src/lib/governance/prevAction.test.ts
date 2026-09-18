// Tests for the purpose-chain rules governing "previous action id" selection
// for chained Conway governance action types.
import { describe, expect, it } from 'vitest';
import { decodeBech32, encodeBech32 } from '../crypto/bech32.js';
import {
  type ChainRow,
  chainForType,
  formatGovActionKey,
  type GovActionRef,
  openInChain,
  parseGovActionRef,
  pickLastEnacted,
  refStillPresent,
} from './prevAction.js';

// A real preprod committee-chain root, verified against a live decode below
// rather than a hard-coded guess at its hex.
const PREPROD_COMMITTEE_ROOT =
  'gov_action1h0arqw4rt5verxf5ld07x6chgcy6pswlk3a9gmxdd6jc4f6ju24qqj0haqp';

function row(overrides: Partial<ChainRow>): ChainRow {
  return {
    proposal_tx_hash: 'a'.repeat(64),
    proposal_index: 0,
    proposal_id: 'gov_action1xxxx',
    proposal_type: 'NoConfidence',
    proposed_epoch: 500,
    ratified_epoch: null,
    enacted_epoch: null,
    expired_epoch: null,
    dropped_epoch: null,
    ...overrides,
  };
}

describe('chainForType', () => {
  it('maps NoConfidence to the committee chain', () => {
    expect(chainForType('NoConfidence')).toEqual(['NoConfidence', 'NewCommittee']);
  });

  it('maps UpdateCommittee to the same committee chain', () => {
    expect(chainForType('UpdateCommittee')).toEqual(['NoConfidence', 'NewCommittee']);
  });

  it('maps NewConstitution to its own chain', () => {
    expect(chainForType('NewConstitution')).toEqual(['NewConstitution']);
  });

  it('maps HardForkInitiation to its own chain', () => {
    expect(chainForType('HardForkInitiation')).toEqual(['HardForkInitiation']);
  });

  it('returns null for InfoAction', () => {
    expect(chainForType('InfoAction')).toBeNull();
  });
});

describe('pickLastEnacted', () => {
  it('returns the row with the highest ratified_epoch', () => {
    const rows = [
      row({ proposal_tx_hash: 'a'.repeat(64), ratified_epoch: 400 }),
      row({ proposal_tx_hash: 'b'.repeat(64), ratified_epoch: 480 }),
      row({ proposal_tx_hash: 'c'.repeat(64), ratified_epoch: 450 }),
    ];
    const picked = pickLastEnacted(rows);
    expect(picked?.proposal_tx_hash).toBe('b'.repeat(64));
  });

  it('returns null when no row has a ratified_epoch', () => {
    const rows = [row({ ratified_epoch: null }), row({ ratified_epoch: undefined })];
    expect(pickLastEnacted(rows)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickLastEnacted([])).toBeNull();
  });
});

describe('openInChain', () => {
  it('keeps only rows with no ratified, enacted, expired or dropped epoch', () => {
    const open = row({ proposal_tx_hash: 'a'.repeat(64), proposed_epoch: 500 });
    const ratified = row({ proposal_tx_hash: 'b'.repeat(64), ratified_epoch: 480 });
    const enacted = row({ proposal_tx_hash: 'c'.repeat(64), enacted_epoch: 481 });
    const expired = row({ proposal_tx_hash: 'd'.repeat(64), expired_epoch: 481 });
    const dropped = row({ proposal_tx_hash: 'e'.repeat(64), dropped_epoch: 481 });
    const result = openInChain([open, ratified, enacted, expired, dropped]);
    expect(result.map(r => r.proposal_tx_hash)).toEqual(['a'.repeat(64)]);
  });

  it('sorts by proposed_epoch descending', () => {
    const older = row({ proposal_tx_hash: 'a'.repeat(64), proposed_epoch: 400 });
    const newer = row({ proposal_tx_hash: 'b'.repeat(64), proposed_epoch: 500 });
    const middle = row({ proposal_tx_hash: 'c'.repeat(64), proposed_epoch: 450 });
    const result = openInChain([older, newer, middle]);
    expect(result.map(r => r.proposal_tx_hash)).toEqual([
      'b'.repeat(64),
      'c'.repeat(64),
      'a'.repeat(64),
    ]);
  });

  it('is stable for ties on proposed_epoch', () => {
    const first = row({ proposal_tx_hash: 'a'.repeat(64), proposed_epoch: 500 });
    const second = row({ proposal_tx_hash: 'b'.repeat(64), proposed_epoch: 500 });
    const result = openInChain([first, second]);
    expect(result.map(r => r.proposal_tx_hash)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });
});

describe('parseGovActionRef', () => {
  it('decodes a real preprod committee-chain root bech32 id', () => {
    const { data } = decodeBech32(PREPROD_COMMITTEE_ROOT);
    const expectedHex = Array.from(data.slice(0, 32))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const ref = parseGovActionRef(PREPROD_COMMITTEE_ROOT);
    expect(ref).not.toBeNull();
    expect(ref?.txHashHex.length).toBe(64);
    expect(ref?.txHashHex).toBe(expectedHex);
    expect(ref?.index).toBe(0);
  });

  it('round-trips a bech32 string built from a known hex and index', () => {
    const hex = 'ab'.repeat(32);
    const payload = new Uint8Array(33);
    for (let i = 0; i < 32; i++) payload[i] = 0xab;
    payload[32] = 0;
    const encoded = encodeBech32('gov_action', payload);
    const ref = parseGovActionRef(encoded);
    expect(ref).toEqual({ txHashHex: hex, index: 0 });
  });

  it('accepts the <hex>#<index> form', () => {
    const hex = 'f'.repeat(64);
    expect(parseGovActionRef(`${hex}#3`)).toEqual({ txHashHex: hex, index: 3 });
  });

  it('lowercases uppercase hex in the <hex>#<index> form', () => {
    const hex = 'F'.repeat(64);
    expect(parseGovActionRef(`${hex}#0`)).toEqual({ txHashHex: 'f'.repeat(64), index: 0 });
  });

  it('returns null for the wrong bech32 prefix', () => {
    const payload = new Uint8Array(33).fill(1);
    const encoded = encodeBech32('drep', payload);
    expect(parseGovActionRef(encoded)).toBeNull();
  });

  it('returns null for a bad checksum', () => {
    const { data } = decodeBech32(PREPROD_COMMITTEE_ROOT);
    void data;
    const corrupted = `${PREPROD_COMMITTEE_ROOT.slice(0, -1)}${
      PREPROD_COMMITTEE_ROOT.endsWith('p') ? 'q' : 'p'
    }`;
    expect(parseGovActionRef(corrupted)).toBeNull();
  });

  it('returns null for the wrong payload length', () => {
    const payload = new Uint8Array(32).fill(2);
    const encoded = encodeBech32('gov_action', payload);
    expect(parseGovActionRef(encoded)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseGovActionRef('not a gov action id')).toBeNull();
    expect(parseGovActionRef('')).toBeNull();
    expect(parseGovActionRef(`${'a'.repeat(63)}#0`)).toBeNull();
  });
});

describe('formatGovActionKey', () => {
  it('formats as <txHashHex>#<index>', () => {
    expect(formatGovActionKey({ txHashHex: 'a'.repeat(64), index: 5 })).toBe(`${'a'.repeat(64)}#5`);
  });
});

describe('refStillPresent', () => {
  const lastEnacted: GovActionRef = {
    txHash: 'a'.repeat(64),
    index: 0,
    id: 'gov_action1xxxx',
    type: 'NoConfidence',
    title: 'Root',
    proposedEpoch: 400,
  };
  const openRow: GovActionRef = {
    txHash: 'b'.repeat(64),
    index: 1,
    id: 'gov_action1yyyy',
    type: 'NewCommittee',
    title: 'Open one',
    proposedEpoch: 500,
  };

  it('is true when chosen matches lastEnacted, compared case-insensitively', () => {
    const chosen = { txHashHex: 'A'.repeat(64), index: 0 };
    expect(refStillPresent(chosen, { lastEnacted, open: [openRow] })).toBe(true);
  });

  it('is true when chosen matches an open row', () => {
    const chosen = { txHashHex: 'b'.repeat(64), index: 1 };
    expect(refStillPresent(chosen, { lastEnacted, open: [openRow] })).toBe(true);
  });

  it('is false when chosen matches neither', () => {
    const chosen = { txHashHex: 'c'.repeat(64), index: 0 };
    expect(refStillPresent(chosen, { lastEnacted, open: [openRow] })).toBe(false);
  });

  it('is true for chosen === null exactly when lastEnacted is null (empty chain)', () => {
    expect(refStillPresent(null, { lastEnacted: null, open: [] })).toBe(true);
  });

  it('is false for chosen === null when lastEnacted is not null', () => {
    expect(refStillPresent(null, { lastEnacted, open: [openRow] })).toBe(false);
  });
});
