import { describe, expect, it } from 'vitest';
import { Role, type SurveyDefinition } from 'cip-179';
import { toJsonSafe } from 'cip-179/tally';
import { hexToBytes } from 'cip-179/domain';
import { EPOCH_LENGTH_SECONDS, resolveNetwork } from '../config/network.js';
import { MAX_EXTERNAL_PROSE_LEN, MAX_EXTERNAL_TITLE_LEN } from '../validation/input.js';
import {
  parseSurveyDefinition,
  questionViews,
  roleLabels,
  surveyDeadlineUnix,
  surveyDescription,
  surveyTitle,
  tesseraSurveyUrl,
} from './view.js';

const cfg = resolveNetwork('preprod');

function definition(overrides: Partial<SurveyDefinition> = {}): SurveyDefinition {
  return {
    specVersion: 5,
    owner: { type: 'key', keyHash: hexToBytes('11'.repeat(28)) },
    title: 'T',
    description: 'D',
    eligibleRoles: [Role.DRep, Role.SPO],
    endEpoch: 300,
    submissionMode: { type: 'public' },
    questions: [
      { type: 'singleChoice', prompt: 'Pick', options: { type: 'options', labels: ['A', 'B'] }, required: true },
      { type: 'multiSelect', prompt: 'Choose', options: { type: 'count', count: 4 }, minSelections: 1, maxSelections: 2 },
      { type: 'numericRange', prompt: 'How much', constraints: { min: 0n, max: 100n } },
    ],
    ...overrides,
  };
}

function wireOf(def: SurveyDefinition): string {
  return JSON.stringify(
    toJsonSafe({
      ref: { txId: hexToBytes('a'.repeat(64)), index: 0 },
      txHash: 'a'.repeat(64),
      slot: 1,
      epochNo: 1,
      definition: def,
    }),
  );
}

describe('surveyDeadlineUnix', () => {
  it('is the start of the epoch after end_epoch (inclusive deadline)', () => {
    expect(surveyDeadlineUnix(300, cfg)).toBe(
      cfg.epochAnchor.unixSeconds + (301 - cfg.epochAnchor.epoch) * EPOCH_LENGTH_SECONDS,
    );
  });
});

describe('definition round-trip and rendering', () => {
  it('parseSurveyDefinition decodes what the sync stored', () => {
    const def = parseSurveyDefinition(wireOf(definition()));
    expect(def?.endEpoch).toBe(300);
    expect(def?.questions).toHaveLength(3);
    // bigint constraints survive the wire form.
    expect(def?.questions[2]).toMatchObject({ type: 'numericRange' });
  });

  it('parseSurveyDefinition is null, not a throw, for a stored form it cannot read', () => {
    expect(parseSurveyDefinition('not json')).toBeNull();
    expect(parseSurveyDefinition('null')).toBeNull();
    expect(parseSurveyDefinition('{"ref":{"txId":{"$bytes":"zz"},"index":0}}')).toBeNull();
    // A record shaped for some other version: no definition, or one without
    // the fields the card and the widget index into.
    expect(parseSurveyDefinition(JSON.stringify({ txHash: 'a'.repeat(64) }))).toBeNull();
    const reshaped = JSON.parse(wireOf(definition()));
    reshaped.definition = { title: 'T', endEpoch: 300 };
    expect(parseSurveyDefinition(JSON.stringify(reshaped))).toBeNull();
  });

  it('caps and strips the title, description, prompts and labels; falls back for an empty title', () => {
    const long = 'x'.repeat(MAX_EXTERNAL_PROSE_LEN + 100);
    const def = definition({
      title: ` Bud\u0000get ${'t'.repeat(MAX_EXTERNAL_TITLE_LEN)}`,
      description: `line one\u0007\n\n\n\n${long}`,
      questions: [
        {
          type: 'singleChoice',
          prompt: `Pick\u0000 ${'p'.repeat(MAX_EXTERNAL_TITLE_LEN)}`,
          options: { type: 'options', labels: [`A\u0000${'a'.repeat(MAX_EXTERNAL_TITLE_LEN)}`, 'B'] },
        },
      ],
    });
    const key = `${'a'.repeat(64)}:7`;
    expect(surveyTitle(def, key)).toBe(`Budget ${'t'.repeat(MAX_EXTERNAL_TITLE_LEN - 7)}`);
    expect(surveyTitle(definition({ title: '' }), key)).toBe('Survey (aaaaaaaa:7)');
    const description = surveyDescription(def);
    expect(description.startsWith('line one\n\nxxx')).toBe(true);
    expect(description).toHaveLength(MAX_EXTERNAL_PROSE_LEN);
    const [q] = questionViews(def);
    expect(q.prompt).toBe(`Pick ${'p'.repeat(MAX_EXTERNAL_TITLE_LEN - 5)}`);
    expect(q.options).toEqual([`A${'a'.repeat(MAX_EXTERNAL_TITLE_LEN - 1)}`, 'B']);
  });

  it('questionViews flattens prompts, kinds, and both option forms', () => {
    const views = questionViews(definition());
    expect(views[0]).toEqual({
      prompt: 'Pick', kindLabel: 'Single choice', options: ['A', 'B'], optionNote: null, required: true,
    });
    expect(views[1]).toMatchObject({
      kindLabel: 'Select 1–2', options: null, optionNote: '4 options (labels in the external document)',
    });
    expect(views[2]).toMatchObject({ kindLabel: 'Number between 0 and 100', required: false });
  });

  it('labels roles and builds the Tessera deep link', () => {
    expect(roleLabels([Role.DRep, Role.SPO])).toBe('DReps, SPOs');
    expect(tesseraSurveyUrl('https://app.example/', `${'a'.repeat(64)}:0`)).toBe(
      `https://app.example/survey/${'a'.repeat(64)}:0`,
    );
    expect(tesseraSurveyUrl(undefined, 'x:0')).toBeNull();
  });
});
