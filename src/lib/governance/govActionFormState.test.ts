import { describe, it, expect } from 'vitest';
import {
  initialGovActionFormState,
  govActionFormReducer,
  effectivePrev,
  draftFromState,
  isFormBlank,
  type GovActionFormState,
} from './govActionFormState.js';
import type { ActionContextResponse } from './actionContextHandler.js';
import type { GovActionDraft } from './govActionDraft.js';

const REF_A = { txHashHex: 'a'.repeat(64), index: 0 };
const REF_B = { txHashHex: 'b'.repeat(64), index: 1 };

function ctx(epoch: number, lastEnactedHash?: string): ActionContextResponse {
  return {
    epoch,
    prev: {
      lastEnacted: lastEnactedHash
        ? {
            txHash: lastEnactedHash,
            index: 0,
            id: 'gov_action1test',
            type: 'NoConfidence',
            title: null,
            proposedEpoch: 100,
          }
        : null,
      open: [],
    },
  };
}

describe('initialGovActionFormState', () => {
  it('starts on InfoAction with empty metadata, empty panels and an idle context', () => {
    const s = initialGovActionFormState();
    expect(s.type).toBe('InfoAction');
    expect(s.metadata.title).toBe('');
    expect(s.metadata.references).toEqual([]);
    expect(s.panels.UpdateCommittee.add).toEqual([]);
    expect(s.context.status).toBe('idle');
    expect(s.context.data).toBeNull();
  });
});

describe('setType', () => {
  it('keeps the metadata and every panel state', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { title: 'Keep me' } });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: { ...s.panels.UpdateCommittee, add: [{ input: 'ab', hexKind: 'key', expiryEpoch: '410' }] },
    });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'HardForkInitiation',
      state: { prev: REF_A, version: { major: 11, minor: 0 } },
    });

    s = govActionFormReducer(s, { kind: 'setType', type: 'NoConfidence' });
    expect(s.type).toBe('NoConfidence');
    expect(s.metadata.title).toBe('Keep me');
    expect(s.panels.UpdateCommittee.add).toHaveLength(1);
    expect(s.panels.HardForkInitiation.version).toEqual({ major: 11, minor: 0 });

    s = govActionFormReducer(s, { kind: 'setType', type: 'UpdateCommittee' });
    expect(s.panels.UpdateCommittee.add[0].expiryEpoch).toBe('410');
  });

  it('drops a loaded context, since it belongs to the type it was fetched for', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(500) });
    expect(s.context.status).toBe('ready');
    s = govActionFormReducer(s, { kind: 'setType', type: 'NewConstitution' });
    expect(s.context.status).toBe('idle');
    expect(s.context.data).toBeNull();
  });
});

describe('context lifecycle', () => {
  it('contextRequested marks loading and records the request id', () => {
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'contextRequested', requestId: 7 });
    expect(s.context.status).toBe('loading');
    expect(s.context.requestId).toBe(7);
  });

  it('contextLoaded stores the data when the id is the latest', () => {
    let s = govActionFormReducer(initialGovActionFormState(), { kind: 'contextRequested', requestId: 3 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 3, data: ctx(501) });
    expect(s.context.status).toBe('ready');
    expect(s.context.data?.epoch).toBe(501);
  });

  it('ignores an out-of-order response from a superseded request', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'setType', type: 'HardForkInitiation' });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    // The slow response for the first (NoConfidence-era) request arrives late.
    const after = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(400) });
    expect(after).toBe(s);
    expect(after.context.status).toBe('loading');
    expect(after.context.data).toBeNull();
  });

  it('ignores a stale failure the same way', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 2, data: ctx(502) });
    const after = govActionFormReducer(s, { kind: 'contextFailed', requestId: 1 });
    expect(after).toBe(s);
    expect(after.context.status).toBe('ready');
  });

  it('contextFailed marks the error for the latest request', () => {
    let s = govActionFormReducer(initialGovActionFormState(), { kind: 'contextRequested', requestId: 9 });
    s = govActionFormReducer(s, { kind: 'contextFailed', requestId: 9 });
    expect(s.context.status).toBe('error');
    expect(s.context.data).toBeNull();
  });

  it('keeps the previous data visible while a refetch is in flight', () => {
    let s = govActionFormReducer(initialGovActionFormState(), { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(500) });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    expect(s.context.status).toBe('loading');
    expect(s.context.data?.epoch).toBe(500);
  });

  it('replaces the context with the fresh submit-time response', () => {
    let s = govActionFormReducer(initialGovActionFormState(), { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(500, 'a'.repeat(64)) });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 2, data: ctx(501, 'b'.repeat(64)) });
    expect(s.context.status).toBe('ready');
    expect(s.context.data?.epoch).toBe(501);
    expect(s.context.data?.prev?.lastEnacted?.txHash).toBe('b'.repeat(64));
  });
});

describe('restoreDraft', () => {
  it('restores the type, the metadata and a v2 panel state', () => {
    const draft: GovActionDraft = {
      v: 2,
      type: 'UpdateCommittee',
      title: 'T',
      abstract: 'A',
      motivation: 'M',
      rationale: 'R',
      signAsAuthor: true,
      authorName: 'Someone',
      references: [{ label: 'L', uri: 'https://example.org' }],
      surveyRef: `${'c'.repeat(64)}:2`,
      panels: {
        UpdateCommittee: {
          prev: REF_B,
          removeHex: ['d'.repeat(56)],
          removeFree: [],
          add: [{ input: 'cc_cold1xyz', hexKind: 'key', expiryEpoch: '520' }],
          quorum: { numerator: '2', denominator: '3' },
        },
      },
    };
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'restoreDraft', draft });
    expect(s.type).toBe('UpdateCommittee');
    expect(s.metadata.title).toBe('T');
    expect(s.metadata.signAsAuthor).toBe(true);
    expect(s.metadata.references).toEqual([{ label: 'L', uri: 'https://example.org' }]);
    expect(s.panels.UpdateCommittee.prev).toEqual(REF_B);
    expect(s.panels.UpdateCommittee.removeHex).toEqual(['d'.repeat(56)]);
    expect(s.panels.UpdateCommittee.add).toEqual([{ input: 'cc_cold1xyz', hexKind: 'key', expiryEpoch: '520' }]);
    expect(s.panels.UpdateCommittee.quorum).toEqual({ numerator: '2', denominator: '3' });
    // Panels the draft does not carry stay at their empty defaults.
    expect(s.panels.HardForkInitiation).toEqual({ prev: null, version: null });
  });

  it('drops malformed panel state instead of failing the restore', () => {
    const draft: GovActionDraft = {
      v: 2,
      type: 'HardForkInitiation',
      title: '',
      abstract: '',
      motivation: '',
      rationale: '',
      signAsAuthor: false,
      authorName: '',
      references: [],
      surveyRef: '',
      panels: {
        HardForkInitiation: { prev: { txHashHex: 42, index: 'x' }, version: { major: 'eleven' } },
        NewConstitution: { text: 12, scriptHashHex: 'ab', prev: null },
      },
    };
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'restoreDraft', draft });
    expect(s.panels.HardForkInitiation).toEqual({ prev: null, version: null });
    expect(s.panels.NewConstitution).toEqual({ prev: null, text: '', scriptHashHex: 'ab' });
  });
});

describe('effectivePrev', () => {
  it('falls back to the chain root when nothing was chosen', () => {
    expect(effectivePrev(null, ctx(500, 'a'.repeat(64)))).toEqual({ txHashHex: 'a'.repeat(64), index: 0 });
  });

  it('is null for an empty chain with no choice', () => {
    expect(effectivePrev(null, ctx(500))).toBeNull();
    expect(effectivePrev(null, null)).toBeNull();
  });

  it('returns the explicit choice unchanged', () => {
    expect(effectivePrev(REF_A, ctx(500, 'b'.repeat(64)))).toEqual(REF_A);
  });
});

describe('draftFromState and isFormBlank', () => {
  it('builds a v2 draft carrying the type and every panel', () => {
    let s: GovActionFormState = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'setType', type: 'NewConstitution' });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'NewConstitution',
      state: { prev: null, text: '# Constitution', scriptHashHex: '' },
    });
    const draft = draftFromState(s);
    expect(draft.v).toBe(2);
    expect(draft.type).toBe('NewConstitution');
    expect(draft.panels.NewConstitution).toEqual({ prev: null, text: '# Constitution', scriptHashHex: '' });
  });

  it('treats the untouched form as blank', () => {
    expect(isFormBlank(initialGovActionFormState())).toBe(true);
  });

  it('keeps a filled panel with empty metadata', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'setType', type: 'UpdateCommittee' });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: { ...s.panels.UpdateCommittee, add: [{ input: 'ab', hexKind: 'key', expiryEpoch: '410' }] },
    });
    expect(isFormBlank(s)).toBe(false);
  });

  it('is not blank once the type alone moved away from InfoAction', () => {
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'setType', type: 'NoConfidence' });
    expect(isFormBlank(s)).toBe(false);
  });

  it('is not blank once any metadata text is typed', () => {
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'setMetadata', patch: { abstract: 'x' } });
    expect(isFormBlank(s)).toBe(false);
  });
});
