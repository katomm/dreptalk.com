import { describe, it, expect } from 'vitest';
import {
  formatValue,
  humanizeKey,
  PARAM_REGISTRY,
  rewardAccountToBech32,
  decodeOnchainChanges,
  summarizeOnchain,
  parameterChangeScope,
  treasuryTotalLovelace,
} from './onchain.js';

describe('formatValue', () => {
  it('formats lovelace as ada', () => {
    expect(formatValue('lovelace', 1000000000)).toBe('1,000 ₳');
  });
  it('formats a float ratio as percent', () => {
    expect(formatValue('ratio', 0.1)).toBe('10%');
  });
  it('formats a {numerator,denominator} ratio as percent', () => {
    expect(formatValue('ratio', { numerator: 2, denominator: 3 })).toBe('66.67%');
  });
  it('formats an int with grouping', () => {
    expect(formatValue('int', 90112)).toBe('90,112');
  });
  it('formats bytes', () => {
    expect(formatValue('bytes', 90112)).toBe('90,112 bytes');
  });
  it('formats exec units', () => {
    expect(formatValue('exUnits', { memory: 16500000, steps: 10000000000 })).toBe(
      '16,500,000 mem / 10,000,000,000 steps',
    );
  });
  it('summarises cost models', () => {
    expect(formatValue('costModels', { PlutusV1: [1, 2] })).toBe('Updated');
  });
});

describe('humanizeKey', () => {
  it('splits camelCase and capitalises', () => {
    expect(humanizeKey('someNewParam')).toBe('Some New Param');
  });
});

describe('PARAM_REGISTRY', () => {
  it('maps govActionDeposit to a lovelace entry', () => {
    expect(PARAM_REGISTRY.govActionDeposit).toEqual({
      snake: 'gov_action_deposit',
      group: 'Governance',
      label: 'Governance Action Deposit',
      format: 'lovelace',
    });
  });
});

describe('rewardAccountToBech32', () => {
  it('encodes a key-hash credential to a stake_test address (preprod)', () => {
    const out = rewardAccountToBech32(
      { credential: { keyHash: '3c79df2221075f32327bbf2aa8ccc22b3d2bc316b076e652eea9b2cd' } },
      'preprod',
    );
    expect(out.startsWith('stake_test1')).toBe(true);
  });
  it('returns a placeholder for a malformed credential', () => {
    expect(rewardAccountToBech32({ credential: {} }, 'preprod')).toBe('(unknown recipient)');
  });
});

const EP = JSON.stringify({
  gov_action_deposit: 100000000000,
  protocol_major: 10,
  protocol_minor: 0,
  treasury_growth_rate: 0.2,
});

describe('decodeOnchainChanges', () => {
  it('returns null for empty payload', () => {
    expect(decodeOnchainChanges(null, EP, 'preprod')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(decodeOnchainChanges('{not json', EP, 'preprod')).toBeNull();
  });

  it('decodes a ParameterChange with old to new', () => {
    const p = JSON.stringify({ tag: 'ParameterChange', contents: [null, { govActionDeposit: 1000000000 }, 'fa'] });
    expect(decodeOnchainChanges(p, EP, 'preprod')).toEqual({
      kind: 'params',
      rows: [{ group: 'Governance', label: 'Governance Action Deposit', oldValue: '100,000 ₳', newValue: '1,000 ₳' }],
    });
  });

  it('falls back to a humanized label for an unknown param key', () => {
    const p = JSON.stringify({ tag: 'ParameterChange', contents: [null, { someNewParam: 5 }, 'fa'] });
    expect(decodeOnchainChanges(p, EP, 'preprod')).toEqual({
      kind: 'params',
      rows: [{ group: 'Other', label: 'Some New Param', oldValue: null, newValue: '5' }],
    });
  });

  it('decodes a HardForkInitiation with old to new version', () => {
    const p = JSON.stringify({ tag: 'HardForkInitiation', contents: [null, { major: 11, minor: 0 }] });
    expect(decodeOnchainChanges(p, EP, 'preprod')).toEqual({ kind: 'hardfork', fromVersion: '10.0', toVersion: '11.0' });
  });

  it('decodes a TreasuryWithdrawals with total', () => {
    const p = JSON.stringify({
      tag: 'TreasuryWithdrawals',
      contents: [
        [[{ network: 'Testnet', credential: { keyHash: '3c79df2221075f32327bbf2aa8ccc22b3d2bc316b076e652eea9b2cd' } }, 5000000]],
        'fa',
      ],
    });
    const r = decodeOnchainChanges(p, EP, 'preprod') as {
      kind: 'treasury';
      rows: { address: string; ada: string }[];
      totalAda: string;
    };
    expect(r.kind).toBe('treasury');
    expect(r.rows[0].ada).toBe('5 ₳');
    expect(r.totalAda).toBe('5 ₳');
    expect(r.rows[0].address.startsWith('stake_test1')).toBe(true);
  });

  it('decodes an UpdateCommittee threshold and members', () => {
    const p = JSON.stringify({
      tag: 'UpdateCommittee',
      contents: [
        null,
        [],
        { 'scriptHash-615b54137e73f090d2dddb04317bee41624f4013e5cfe4a5efa76d76': 372 },
        { numerator: 2, denominator: 3 },
      ],
    });
    const r = decodeOnchainChanges(p, EP, 'preprod') as {
      kind: 'committee';
      added: { who: string }[];
      threshold: string;
    };
    expect(r.kind).toBe('committee');
    expect(r.threshold).toBe('67%');
    expect(r.added[0].who).toContain('scriptHash');
  });

  it('renders a whole-percent committee threshold without dropping the trailing zero', () => {
    const p = JSON.stringify({ tag: 'UpdateCommittee', contents: [null, [], {}, { numerator: 1, denominator: 2 }] });
    const r = decodeOnchainChanges(p, EP, 'preprod') as { threshold: string };
    expect(r.threshold).toBe('50%');
  });

  it('returns a note for InfoAction', () => {
    const p = JSON.stringify({ tag: 'InfoAction' });
    expect(decodeOnchainChanges(p, EP, 'preprod')).toEqual({
      kind: 'note',
      tag: 'InfoAction',
      text: 'Informational action. No on-chain effect; the vote signals opinion only.',
    });
  });
});

describe('summarizeOnchain', () => {
  it('summarizes treasury as a requested amount', () => {
    const p = JSON.stringify({
      tag: 'TreasuryWithdrawals',
      contents: [[[{ credential: { keyHash: '3c79df2221075f32327bbf2aa8ccc22b3d2bc316b076e652eea9b2cd' } }, 5000000]], 'fa'],
    });
    expect(summarizeOnchain(decodeOnchainChanges(p, EP, 'preprod'))).toEqual({
      prefix: 'Requesting',
      oldValue: null,
      value: '5 ₳',
      tone: 'amount',
    });
  });

  it('summarizes a single param as an old→new change', () => {
    const p = JSON.stringify({ tag: 'ParameterChange', contents: [null, { minPoolCost: 170000000 }, 'fa'] });
    const s = summarizeOnchain(decodeOnchainChanges(p, EP, 'preprod'));
    expect(s?.tone).toBe('change');
    expect(s?.prefix).toBe('Min Pool Cost');
    expect(s?.value).toBe('170 ₳');
  });

  it('counts multiple params instead of listing them', () => {
    const p = JSON.stringify({ tag: 'ParameterChange', contents: [null, { minPoolCost: 1, dRepDeposit: 2 }, 'fa'] });
    expect(summarizeOnchain(decodeOnchainChanges(p, EP, 'preprod'))).toEqual({
      prefix: null,
      oldValue: null,
      value: '2 parameters changed',
      tone: 'plain',
    });
  });

  it('summarizes a hard fork as a protocol version change', () => {
    const p = JSON.stringify({ tag: 'HardForkInitiation', contents: [null, { major: 11, minor: 0 }] });
    const s = summarizeOnchain(decodeOnchainChanges(p, EP, 'preprod'));
    expect(s).toMatchObject({ prefix: 'Protocol', value: '11.0', tone: 'change' });
  });

  it('shows a line for no-confidence but not for an info action', () => {
    const nc = JSON.stringify({ tag: 'NoConfidence' });
    expect(summarizeOnchain(decodeOnchainChanges(nc, EP, 'preprod'))).toMatchObject({ value: 'No-confidence motion' });
    const info = JSON.stringify({ tag: 'InfoAction' });
    expect(summarizeOnchain(decodeOnchainChanges(info, EP, 'preprod'))).toBeNull();
  });
});

describe('parameterChangeScope', () => {
  const pc = (map: Record<string, unknown>) =>
    JSON.stringify({ tag: 'ParameterChange', contents: [null, map, 'fa'] });

  it('classifies a governance-only change with no security parameter', () => {
    expect(parameterChangeScope(pc({ committeeMinSize: 5 }))).toEqual({
      groups: ['governance'],
      touchesSecurity: false,
    });
  });

  it('flags a security-relevant change with its DRep group', () => {
    // minFeeA is economic for DReps and security-relevant for SPOs.
    expect(parameterChangeScope(pc({ minFeeA: 50 }))).toEqual({
      groups: ['economic'],
      touchesSecurity: true,
    });
  });

  it('treats govActionDeposit as governance group and security-relevant', () => {
    expect(parameterChangeScope(pc({ govActionDeposit: 100_000_000_000 }))).toEqual({
      groups: ['governance'],
      touchesSecurity: true,
    });
  });

  it('collects every touched group; security is true if any parameter qualifies', () => {
    const s = parameterChangeScope(pc({ committeeMinSize: 5, maxTxSize: 16384 }))!;
    expect([...s.groups].sort()).toEqual(['governance', 'network']);
    expect(s.touchesSecurity).toBe(true); // maxTxSize is security-relevant
  });

  it('returns null for a missing, malformed, or non-parameter-change payload', () => {
    expect(parameterChangeScope(null)).toBeNull();
    expect(parameterChangeScope('{bad')).toBeNull();
    expect(parameterChangeScope(JSON.stringify({ tag: 'HardForkInitiation', contents: [] }))).toBeNull();
  });
});

const treasuryPayload = {
  tag: 'TreasuryWithdrawals',
  contents: [
    [
      [{ credential: { keyHash: 'a'.repeat(56) } }, 50_000_000_000_000],
      [{ credential: { keyHash: 'b'.repeat(56) } }, '25000000000000'],
    ],
  ],
};

describe('treasuryTotalLovelace', () => {
  it('sums number and string lovelace amounts', () => {
    expect(treasuryTotalLovelace(treasuryPayload)).toBe(75_000_000_000_000n);
  });

  it('returns 0n for a non-treasury payload', () => {
    expect(treasuryTotalLovelace({ tag: 'InfoAction', contents: [] })).toBe(0n);
    expect(treasuryTotalLovelace(null)).toBe(0n);
    expect(treasuryTotalLovelace({})).toBe(0n);
  });
});
