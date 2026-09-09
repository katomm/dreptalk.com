import { Role, type SurveyDefinition } from 'cip-179';
import {
  aggregate,
  type GovLink,
  hexToBytes,
  QUICKNET_CHAIN_HASH,
  type SurveyRecord,
} from 'cip-179/domain';
import { describe, expect, it } from 'vitest';
import { eligibleSurvey } from './admission.js';

const TX = 'a'.repeat(64);
const KEY = `${TX}:0`;
const ACTION = 'gov_action1linkedaction';
const OTHER_ACTION = 'gov_action1otheraction';

const tip = {
  epoch: 300,
  slot: 60_000_000,
  time: 1_780_000_000,
  epochSlot: 5_000,
  govActionLifetime: 6,
};

function definition(overrides: Partial<SurveyDefinition> = {}): SurveyDefinition {
  return {
    specVersion: 5,
    owner: { type: 'key', keyHash: hexToBytes('11'.repeat(28)) },
    title: 'Treasury priorities',
    description: '',
    eligibleRoles: [Role.DRep],
    endEpoch: 300,
    submissionMode: { type: 'public' },
    questions: [
      {
        type: 'singleChoice',
        prompt: 'Pick one',
        options: { type: 'options', labels: ['A', 'B'] },
      },
    ],
    ...overrides,
  };
}

function aggregateOf(def: SurveyDefinition, links: readonly GovLink[] = linkedBy(ACTION)) {
  const record: SurveyRecord = {
    txHash: TX,
    slot: tip.slot - 10_000,
    epochNo: tip.epoch - 1,
    ref: { txId: hexToBytes(TX), index: 0 },
    definition: def,
  };
  const [a] = aggregate([record], [], {}, tip, links);
  return a;
}

function linkedBy(...actionIds: string[]): GovLink[] {
  return actionIds.map(actionId => ({ surveyKey: KEY, actionId, endEpoch: 300, title: null }));
}

describe('eligibleSurvey', () => {
  it('accepts a public, talliable, DRep-eligible survey', () => {
    expect(eligibleSurvey(aggregateOf(definition()))).toBe(true);
  });

  it('refuses a survey DReps cannot answer', () => {
    expect(eligibleSurvey(aggregateOf(definition({ eligibleRoles: [Role.SPO] })))).toBe(false);
  });

  it('refuses an untalliable definition, as aggregate() judges it', () => {
    const a = aggregateOf(definition({ questions: [] }));
    expect(a.talliable).toBe(false);
    expect(eligibleSurvey(a)).toBe(false);
  });

  it('accepts a sealed survey on quicknet and refuses one on any other drand chain', () => {
    const sealed = (chainHash: Uint8Array) =>
      definition({ submissionMode: { type: 'sealed', chainHash, round: 1_000, paddingSize: 64 } });
    const onQuicknet = aggregateOf(sealed(QUICKNET_CHAIN_HASH));
    expect(onQuicknet.sealed).toBe(true);
    expect(eligibleSurvey(onQuicknet)).toBe(true);
    // Still talliable in aggregate()'s terms: the refusal is its second
    // verdict, the finalizer's, applied before a thread is opened.
    const elsewhere = aggregateOf(sealed(hexToBytes('ff'.repeat(32))));
    expect(elsewhere.talliable).toBe(true);
    expect(elsewhere.sealedUnsupported).toBe(true);
    expect(eligibleSurvey(elsewhere)).toBe(false);
  });

  it('needs at least one link, to any action — whether it is imported is not its question', () => {
    expect(eligibleSurvey(aggregateOf(definition(), linkedBy(OTHER_ACTION)))).toBe(true);
    expect(eligibleSurvey(aggregateOf(definition(), linkedBy(OTHER_ACTION, ACTION)))).toBe(true);
    expect(eligibleSurvey(aggregateOf(definition(), []))).toBe(false);
  });
});
