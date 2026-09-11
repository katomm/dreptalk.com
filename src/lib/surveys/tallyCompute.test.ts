import { describe, expect, it } from 'vitest';
import { Role, type SurveyDefinition } from 'cip-179';
// bytesToHex is deliberately absent: this file builds credentials from hex, it
// never reads one back. Biome fails the build on an unused import.
import { hexToBytes, type ResponseRecord } from 'cip-179/domain';
import type { PowerLookup } from '../db/drepPower.js';
import { computeSurveyTally } from './tallyCompute.js';

const TX = 'a'.repeat(64);
const DREP_A = '11'.repeat(28);
const DREP_B = '22'.repeat(28);
const DREP_C = '33'.repeat(28);

function definition(overrides: Partial<SurveyDefinition> = {}): SurveyDefinition {
  return {
    specVersion: 5,
    owner: { type: 'key', keyHash: hexToBytes('99'.repeat(28)) },
    title: 'T',
    description: 'D',
    eligibleRoles: [Role.DRep],
    endEpoch: 316,
    submissionMode: { type: 'public' },
    questions: [
      {
        type: 'singleChoice',
        prompt: 'Choose',
        options: { type: 'options', labels: ['A', 'B'] },
        required: true,
      },
    ],
    ...overrides,
  };
}

function response(
  drepHex: string,
  optionIndex: number,
  opts: { epochNo?: number; slot?: number; txHash?: string; role?: Role; isScript?: boolean } = {},
): ResponseRecord {
  return {
    txHash: opts.txHash ?? TX,
    slot: opts.slot ?? 1000,
    epochNo: opts.epochNo ?? 310,
    responseIndex: 0,
    response: {
      specVersion: 5,
      surveyRef: { txId: hexToBytes(TX), index: 0 },
      role: opts.role ?? Role.DRep,
      credential: opts.isScript
        ? { type: 'script', scriptHash: hexToBytes(drepHex) }
        : { type: 'key', keyHash: hexToBytes(drepHex) },
      answers: {
        type: 'public',
        answers: [{ type: 'singleChoice', questionIndex: 0, optionIndex }],
      },
    },
  };
}

// scriptMap is keyed the same way as map, but only consulted for a script
// credential. Most tests never pass it, so a key credential and a script
// credential sharing a hex never collide unless a test asks for both.
function power(
  map: Record<string, bigint | null>,
  total: string | null = '10000000',
  scriptMap: Record<string, bigint | null> = {},
): PowerLookup {
  return {
    epoch: 312,
    totalPower: total,
    weightOf: (hex, isScript) => {
      const m = isScript ? scriptMap : map;
      return hex in m ? m[hex]! : null;
    },
  };
}

describe('computeSurveyTally', () => {
  it('counts the latest response per credential and tags the rest as superseded', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [
        response(DREP_A, 0, { slot: 1000 }),
        response(DREP_A, 1, { slot: 2000, txHash: 'b'.repeat(64) }),
        response(DREP_B, 0, { slot: 3000, txHash: 'c'.repeat(64) }),
      ],
      verdicts: undefined,
      power: power({ [DREP_A]: 3_000_000n, [DREP_B]: 1_000_000n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(2);
    expect(r.excluded).toBe(1);
    expect(r.excludedBy).toEqual({ superseded: 1 });
  });

  it('keeps an unresolvable DRep in the head count and out of the weighted run', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0), response(DREP_C, 1, { txHash: 'b'.repeat(64) })],
      verdicts: undefined,
      power: power({ [DREP_A]: 4_000_000n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(2);
    expect(r.matchedCount).toBe(1);
    expect(r.answeredPower).toBe('4000000');
    const head = r.questions.headcount[0]!;
    const weighted = r.questions.weighted[0]!;
    if (head.kind !== 'options' || weighted.kind !== 'options') throw new Error('kind');
    expect(head.answeredCount).toBe(2);
    expect(weighted.answeredCount).toBe(1);
  });

  it('keeps a resolved DRep with zero power inside the weighted run', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0), response(DREP_B, 1, { txHash: 'b'.repeat(64) })],
      verdicts: undefined,
      power: power({ [DREP_A]: 4_000_000n, [DREP_B]: 0n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(2);
    expect(r.matchedCount).toBe(2);
    expect(r.answeredPower).toBe('4000000');
    const weighted = r.questions.weighted[0]!;
    if (weighted.kind !== 'options') throw new Error('kind');
    expect(weighted.answeredCount).toBe(2);
  });

  it('carries the head count per option, so both readings come from one shape', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [
        response(DREP_A, 0),
        response(DREP_B, 0, { txHash: 'b'.repeat(64) }),
      ],
      verdicts: undefined,
      power: power({ [DREP_A]: 3_000_000n, [DREP_B]: 1_000_000n }),
      artifact: null,
      sealed: false,
    });
    const weighted = r.questions.weighted[0]!;
    if (weighted.kind !== 'options') throw new Error('kind');
    expect(weighted.options[0]!.count).toBe(2);
    expect(weighted.options[0]!.weight).toBe('4000000');
  });

  it('excludes a response past the end epoch', () => {
    const r = computeSurveyTally({
      definition: definition({ endEpoch: 300 }),
      responses: [response(DREP_A, 0, { epochNo: 301 })],
      verdicts: undefined,
      power: power({ [DREP_A]: 1n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(0);
    expect(r.excludedBy).toEqual({ 'after-deadline': 1 });
  });

  it('keeps a response with no proof verdict counted, because pending is not failed', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0)],
      verdicts: {},
      power: power({ [DREP_A]: 1n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(1);
    expect(r.excluded).toBe(0);
    // {} means audited and nothing excluded, a known fact. null would mean
    // the breakdown is unknown, which this function never produces.
    expect(r.excludedBy).toEqual({});
    expect(r.excludedBy).not.toBeNull();
  });

  it('excludes a response whose proof verdict is false', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0)],
      verdicts: { [`${TX}:0`]: false },
      power: power({ [DREP_A]: 1n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(0);
    expect(r.excludedBy).toEqual({ unproven: 1 });
  });

  it('counts only responses claiming role DRep, and records the other roles', () => {
    const r = computeSurveyTally({
      definition: definition({ eligibleRoles: [Role.DRep, Role.SPO] }),
      responses: [
        response(DREP_A, 0),
        response(DREP_B, 1, { txHash: 'b'.repeat(64), role: Role.SPO }),
      ],
      verdicts: undefined,
      power: power({ [DREP_A]: 5n, [DREP_B]: 5n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(1);
    expect(r.roleCounts).toEqual({ [Role.DRep]: 1, [Role.SPO]: 1 });
  });

  it('omits role counts when only DReps responded', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0)],
      verdicts: undefined,
      power: power({ [DREP_A]: 5n }),
      artifact: null,
      sealed: false,
    });
    expect(r.roleCounts).toBeNull();
  });

  it('takes every weighted figure from the artifact, as one consistent set', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0), response(DREP_B, 1, { txHash: 'b'.repeat(64) })],
      verdicts: undefined,
      // Local power says something entirely different, and must not leak in.
      power: power({ [DREP_A]: 3_000_000n, [DREP_B]: 1_000_000n }, '99999'),
      artifact: {
        endEpoch: 316,
        role: {
          role: Role.DRep,
          total: '50000000',
          responders: [
            { credential: `key:${DREP_A}`, weight: '7000000', txHash: TX, responseIndex: 0 },
          ],
          questions: [
            {
              kind: 'options',
              unit: 'singleChoice',
              options: [{ index: 0, weight: '7000000', count: 1 }],
              answeredCount: 1,
              answeredWeight: '7000000',
            },
          ],
        },
      },
      sealed: false,
    });
    expect(r.weightedSource).toBe('artifact');
    expect(r.powerEpoch).toBe(316);
    expect(r.matchedCount).toBe(1);
    expect(r.answeredPower).toBe('7000000');
    expect(r.totalPower).toBe('50000000');
    // Head count and exclusions stay ours, because an artifact carries neither.
    expect(r.counted).toBe(2);
    expect(r.headcountSource).toBe('audit');
    const head = r.questions.headcount[0]!;
    if (head.kind !== 'options') throw new Error('kind');
    expect(head.answeredCount).toBe(2);
  });

  it('sums the artifact responders rather than reading a question maximum', () => {
    // The F1 counterexample. Two responders weighing 3 and 5 answer two
    // different optional questions, so the question weights are 3 and 5 and
    // their maximum is 5, while the participating power is 8.
    const r = computeSurveyTally({
      definition: definition({
        questions: [
          { type: 'singleChoice', prompt: 'Q1', options: { type: 'options', labels: ['A'] } },
          { type: 'singleChoice', prompt: 'Q2', options: { type: 'options', labels: ['A'] } },
        ],
      }),
      responses: [response(DREP_A, 0)],
      verdicts: undefined,
      power: power({ [DREP_A]: 1n }),
      artifact: {
        endEpoch: 316,
        role: {
          role: Role.DRep,
          total: '100',
          responders: [
            { credential: `key:${DREP_A}`, weight: '3', txHash: TX, responseIndex: 0 },
            { credential: `key:${DREP_B}`, weight: '5', txHash: 'b'.repeat(64), responseIndex: 0 },
          ],
          questions: [
            { kind: 'options', unit: 'singleChoice', options: [{ index: 0, weight: '3', count: 1 }], answeredCount: 1, answeredWeight: '3' },
            { kind: 'options', unit: 'singleChoice', options: [{ index: 0, weight: '5', count: 1 }], answeredCount: 1, answeredWeight: '5' },
          ],
        },
      },
      sealed: false,
    });
    expect(r.answeredPower).toBe('8');
    expect(r.matchedCount).toBe(2);
  });

  it('treats an artifact role with no responders as zero, still on the artifact path', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0)],
      verdicts: undefined,
      power: power({ [DREP_A]: 5n }),
      artifact: {
        endEpoch: 316,
        role: { role: Role.DRep, total: '100', responders: [], questions: [] },
      },
      sealed: false,
    });
    expect(r.weightedSource).toBe('artifact');
    expect(r.matchedCount).toBe(0);
    expect(r.answeredPower).toBe('0');
    // The head count still exists, which is the whole point of run A.
    expect(r.counted).toBe(1);
  });

  it('takes a sealed survey head count from the artifact and says so', () => {
    const r = computeSurveyTally({
      definition: definition({ submissionMode: { type: 'sealed', round: 1, paddingSize: 16, chainHash: hexToBytes('ab'.repeat(32)) } }),
      responses: [response(DREP_A, 0)],
      verdicts: undefined,
      power: power({ [DREP_A]: 5n }),
      artifact: {
        endEpoch: 316,
        role: {
          role: Role.DRep,
          total: '100',
          responders: [{ credential: `key:${DREP_A}`, weight: '5', txHash: TX, responseIndex: 0 }],
          questions: [
            { kind: 'options', unit: 'singleChoice', options: [{ index: 1, weight: '5', count: 1 }], answeredCount: 1, answeredWeight: '5' },
          ],
        },
      },
      sealed: true,
    });
    expect(r.headcountSource).toBe('artifact');
    expect(r.questions.headcount).toEqual(r.questions.weighted);
  });

  it('reports zero answered power without inventing a denominator', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0)],
      verdicts: undefined,
      power: power({ [DREP_A]: 0n }),
      artifact: null,
      sealed: false,
    });
    expect(r.answeredPower).toBe('0');
    expect(r.matchedCount).toBe(1);
  });

  it('survives a weight past the exact-integer range without a float', () => {
    const big = 9_007_199_254_740_993n;
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0)],
      verdicts: undefined,
      power: power({ [DREP_A]: big }),
      artifact: null,
      sealed: false,
    });
    expect(r.answeredPower).toBe(big.toString());
  });

  it('weights a script credential from the script power row, not a key row sharing its hash', () => {
    const r = computeSurveyTally({
      definition: definition(),
      responses: [response(DREP_A, 0, { isScript: true })],
      verdicts: undefined,
      // Same hash, two different rows: key weighs 1,000,000 and script weighs
      // 9,000,000. Dropping isScript from the lookup key would silently pick
      // the key row and this test would catch the wrong weight.
      power: power({ [DREP_A]: 1_000_000n }, '10000000', { [DREP_A]: 9_000_000n }),
      artifact: null,
      sealed: false,
    });
    expect(r.matchedCount).toBe(1);
    expect(r.answeredPower).toBe('9000000');
  });

  it('narrows excluded and excludedBy to the DRep claim, same as counted', () => {
    const r = computeSurveyTally({
      definition: definition({ eligibleRoles: [Role.DRep, Role.SPO] }),
      responses: [
        response(DREP_A, 0),
        response(DREP_B, 1, { txHash: 'b'.repeat(64), role: Role.SPO }),
      ],
      // Both responses fail their proof verdict, so both are excluded by the
      // library's audit, one claiming DRep and one claiming SPO.
      verdicts: { [`${TX}:0`]: false, [`${'b'.repeat(64)}:0`]: false },
      power: power({ [DREP_A]: 1n, [DREP_B]: 1n }),
      artifact: null,
      sealed: false,
    });
    expect(r.counted).toBe(0);
    // Only the DRep exclusion shows up. If the role filter were removed, this
    // would read excluded: 2 and excludedBy: { unproven: 2 }.
    expect(r.excluded).toBe(1);
    expect(r.excludedBy).toEqual({ unproven: 1 });
  });
});
