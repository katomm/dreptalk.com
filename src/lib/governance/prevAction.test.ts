// Tests for the purpose-chain rules governing "previous action id" selection
// for chained Conway governance action types.
import { describe, expect, it } from 'vitest';
import {
  type ChainRow,
  chainForType,
  GOV_ACTION_FORM_TYPES,
  formatGovActionKey,
  type GovActionRef,
  koiosProposalType,
  matchesRef,
  needsContext,
  openInChain,
  pickLastEnacted,
  refStillPresent,
} from './prevAction.js';

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

describe('matchesRef', () => {
  it('matches a candidate row whose tx hash differs only in case', () => {
    const ref = { txHashHex: 'A'.repeat(64), index: 2 };
    expect(matchesRef(ref, { txHash: 'a'.repeat(64), index: 2 })).toBe(true);
  });

  it('does not match when the index differs', () => {
    const ref = { txHashHex: 'a'.repeat(64), index: 2 };
    expect(matchesRef(ref, { txHash: 'a'.repeat(64), index: 3 })).toBe(false);
  });

  it('does not match a different tx hash', () => {
    const ref = { txHashHex: 'a'.repeat(64), index: 0 };
    expect(matchesRef(ref, { txHash: 'b'.repeat(64), index: 0 })).toBe(false);
  });
});

describe('koiosProposalType', () => {
  it('maps the form name UpdateCommittee to Koios NewCommittee', () => {
    expect(koiosProposalType('UpdateCommittee')).toBe('NewCommittee');
  });

  it('leaves every other form type unchanged', () => {
    expect(koiosProposalType('NoConfidence')).toBe('NoConfidence');
    expect(koiosProposalType('HardForkInitiation')).toBe('HardForkInitiation');
    expect(koiosProposalType('NewConstitution')).toBe('NewConstitution');
    expect(koiosProposalType('InfoAction')).toBe('InfoAction');
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

describe('treasury withdrawals in the type list', () => {
  it('has no purpose chain but needs a context', () => {
    expect(chainForType('TreasuryWithdrawals')).toBeNull();
    expect(needsContext('TreasuryWithdrawals')).toBe(true);
  });

  it('needs a context for every type except InfoAction', () => {
    expect(GOV_ACTION_FORM_TYPES.filter((type) => !needsContext(type))).toEqual(['InfoAction']);
  });
});

describe('ParameterChange', () => {
  it('gives ParameterChange its own chain', () => {
    expect(chainForType('ParameterChange')).toEqual(['ParameterChange']);
    expect(koiosProposalType('ParameterChange')).toBe('ParameterChange');
    expect(needsContext('ParameterChange')).toBe(true);
    expect(GOV_ACTION_FORM_TYPES).toContain('ParameterChange');
  });
});
