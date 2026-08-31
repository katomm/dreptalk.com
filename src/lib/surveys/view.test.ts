import { describe, expect, it } from 'vitest';
import { Role, type SurveyDefinition } from 'cip-179';
import { toJsonSafe } from 'cip-179/tally';
import { hexToBytes } from 'cip-179/domain';
import { EPOCH_LENGTH_SECONDS, resolveNetwork } from '../config/network.js';
import {
  parseSurveyDefinition,
  questionViews,
  roleLabels,
  surveyDeadlineUnix,
  surveyLifecycle,
  tesseraSurveyUrl,
} from './view.js';

const cfg = resolveNetwork('preprod');

function definition(): SurveyDefinition {
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
  };
}

describe('surveyLifecycle', () => {
  const startOf = (epoch: number) =>
    (cfg.epochAnchor.unixSeconds + (epoch - cfg.epochAnchor.epoch) * EPOCH_LENGTH_SECONDS) * 1000;

  it('is open through end_epoch inclusive and closed from the next epoch', () => {
    const row = { endEpoch: 300, cancelled: false };
    // Last millisecond-ish of epoch 300 (the inclusive deadline).
    expect(surveyLifecycle(row, startOf(301) - 1000, cfg)).toBe('open');
    expect(surveyLifecycle(row, startOf(301), cfg)).toBe('closed');
  });

  it('cancelled wins over the clock', () => {
    expect(surveyLifecycle({ endEpoch: 300, cancelled: true }, startOf(299), cfg)).toBe('cancelled');
  });
});

describe('surveyDeadlineUnix', () => {
  it('is the start of the epoch after end_epoch (inclusive deadline)', () => {
    expect(surveyDeadlineUnix(300, cfg)).toBe(
      cfg.epochAnchor.unixSeconds + (301 - cfg.epochAnchor.epoch) * EPOCH_LENGTH_SECONDS,
    );
  });
});

describe('definition round-trip and rendering', () => {
  it('parseSurveyDefinition decodes what the sync stored', () => {
    const wire = JSON.stringify(toJsonSafe({ ref: { txId: hexToBytes('a'.repeat(64)), index: 0 }, txHash: 'a'.repeat(64), slot: 1, epochNo: 1, definition: definition() }));
    const def = parseSurveyDefinition(wire);
    expect(def.endEpoch).toBe(300);
    expect(def.questions).toHaveLength(3);
    // bigint constraints survive the wire form.
    expect(def.questions[2]).toMatchObject({ type: 'numericRange' });
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
