import { Role, type SurveyDefinition } from 'cip-179';
import { aggregate, type GovLink, hexToBytes, type SurveyRecord } from 'cip-179/domain';
import { QUICKNET_CHAIN_HASH } from 'cip-179/tlock';
import { describe, expect, it } from 'vitest';
import { admissible, eligibleSurvey } from './admission.js';

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

const IMPORTED = new Set([ACTION]);

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
    // aggregate() still calls the other chain talliable: the refusal here is
    // the finalizer's later verdict, applied before a thread is opened.
    const elsewhere = aggregateOf(sealed(hexToBytes('ff'.repeat(32))));
    expect(elsewhere.talliable).toBe(true);
    expect(eligibleSurvey(elsewhere)).toBe(false);
  });
});

describe('admissible', () => {
  it('needs one link to an imported action, whichever position it holds', () => {
    expect(admissible(aggregateOf(definition()), IMPORTED)).toBe(true);
    expect(admissible(aggregateOf(definition(), linkedBy(OTHER_ACTION, ACTION)), IMPORTED)).toBe(
      true,
    );
    expect(admissible(aggregateOf(definition(), linkedBy(OTHER_ACTION)), IMPORTED)).toBe(false);
    expect(admissible(aggregateOf(definition(), []), IMPORTED)).toBe(false);
    expect(admissible(aggregateOf(definition()), new Set())).toBe(false);
  });

  it('is the eligibility rule and the link rule together', () => {
    expect(admissible(aggregateOf(definition({ questions: [] })), IMPORTED)).toBe(false);
  });
});
