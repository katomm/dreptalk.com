import { describe, it, expect } from 'vitest';
import { decodeOnchainChanges } from './onchain.js';
import { diffEpochParams, normalizeParamValue, paramRowFromLog, payloadKoiosFields } from './paramLog.js';

describe('normalizeParamValue', () => {
  it('sorts keys recursively and writes whole numbers as digit strings', () => {
    expect(normalizeParamValue({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":["2",{"c":"0","d":"1"}],"b":"1"}');
  });
  it('maps null and undefined to null', () => {
    expect(normalizeParamValue(null)).toBe('null');
    expect(normalizeParamValue(undefined)).toBe('null');
  });
  it('treats a number and its digit string alike', () => {
    expect(normalizeParamValue(2000000)).toBe('"2000000"');
    expect(normalizeParamValue('2000000')).toBe('"2000000"');
  });
  it('keeps decimals as numbers', () => {
    expect(normalizeParamValue(0.3)).toBe('0.3');
  });
});

describe('diffEpochParams', () => {
  it('reports only non-null, non-excluded fields against an empty log', () => {
    expect(diffEpochParams(new Map(), { epoch_no: 208, nonce: 'ab', min_fee_a: 44, drep_deposit: null })).toEqual([
      { paramKey: 'min_fee_a', valueJson: '"44"' },
    ]);
  });
  it('compares against the newest logged value', () => {
    const latest = new Map([['min_fee_a', '"44"']]);
    expect(diffEpochParams(latest, { min_fee_a: 44 })).toEqual([]);
    expect(diffEpochParams(latest, { min_fee_a: '44' })).toEqual([]);
    expect(diffEpochParams(latest, { min_fee_a: 45 })).toEqual([{ paramKey: 'min_fee_a', valueJson: '"45"' }]);
    expect(diffEpochParams(latest, { min_fee_a: null })).toEqual([{ paramKey: 'min_fee_a', valueJson: 'null' }]);
    expect(diffEpochParams(latest, {})).toEqual([{ paramKey: 'min_fee_a', valueJson: 'null' }]);
  });
  it('ignores cost model key order and catches a changed number inside', () => {
    const latest = new Map([['cost_models', normalizeParamValue({ PlutusV1: [1, 2], PlutusV2: [3] })]]);
    expect(diffEpochParams(latest, { cost_models: { PlutusV2: [3], PlutusV1: [1, 2] } })).toEqual([]);
    expect(diffEpochParams(latest, { cost_models: { PlutusV2: [3], PlutusV1: [1, 9] } })).toHaveLength(1);
  });
});

describe('paramRowFromLog', () => {
  it('parses values and leaves out null', () => {
    expect(
      paramRowFromLog([
        { paramKey: 'min_fee_a', valueJson: '"44"' },
        { paramKey: 'decentralisation', valueJson: 'null' },
      ]),
    ).toEqual({ min_fee_a: '44' });
  });
});

describe('decodeOnchainChanges parity', () => {
  it('decodes a logged row like the raw Koios row', () => {
    const row = {
      epoch_no: 662,
      min_fee_a: 44,
      key_deposit: '2000000',
      coins_per_utxo_size: '4310',
      influence: 0.3,
      cost_models: { PlutusV1: [205665, 812, 1], PlutusV2: [100788, 420] },
    };
    const payload = JSON.stringify({
      tag: 'ParameterChange',
      contents: [null, { txFeePerByte: 45, utxoCostPerByte: 4400, poolPledgeInfluence: 0.4, costModels: { PlutusV1: [1] } }],
    });
    const fromRaw = decodeOnchainChanges(payload, JSON.stringify(row), 'preprod');
    const logged = paramRowFromLog(diffEpochParams(new Map(), row));
    const fromLog = decodeOnchainChanges(payload, JSON.stringify(logged), 'preprod');
    expect(fromRaw).toMatchObject({ kind: 'params' });
    expect(fromLog).toEqual(fromRaw);
  });
});

describe('payloadKoiosFields', () => {
  it('uses the registry field, resolving aliases', () => {
    expect(payloadKoiosFields('txFeePerByte')).toEqual(['min_fee_a']);
    expect(payloadKoiosFields('minFeeA')).toEqual(['min_fee_a']);
  });
  it('maps structured parameters to their fields', () => {
    expect(payloadKoiosFields('maxTxExecutionUnits')).toEqual(['max_tx_ex_mem', 'max_tx_ex_steps']);
    expect(payloadKoiosFields('poolVotingThresholds')).toContain('pvtpp_security_group');
    expect(payloadKoiosFields('dRepVotingThresholds')).toContain('dvt_p_p_gov_group');
  });
  it('returns nothing for unknown keys and prototype names', () => {
    expect(payloadKoiosFields('constructor')).toEqual([]);
    expect(payloadKoiosFields('nope')).toEqual([]);
  });
});
