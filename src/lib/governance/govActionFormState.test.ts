import { describe, it, expect } from 'vitest';
import {
  initialGovActionFormState,
  govActionFormReducer,
  effectivePrev,
  draftFromState,
  isFormBlank,
  committeeMode,
  validateCommitteePanel,
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
      state: {
        ...s.panels.UpdateCommittee,
        add: [{ input: 'ab', hexKind: 'key', expiryEpoch: '410' }],
      },
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
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'contextRequested',
      requestId: 7,
    });
    expect(s.context.status).toBe('loading');
    expect(s.context.requestId).toBe(7);
  });

  it('contextLoaded stores the data when the id is the latest', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'contextRequested',
      requestId: 3,
    });
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
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'contextRequested',
      requestId: 9,
    });
    s = govActionFormReducer(s, { kind: 'contextFailed', requestId: 9 });
    expect(s.context.status).toBe('error');
    expect(s.context.data).toBeNull();
  });

  it('keeps the previous data visible while a refetch is in flight', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'contextRequested',
      requestId: 1,
    });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(500) });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    expect(s.context.status).toBe('loading');
    expect(s.context.data?.epoch).toBe(500);
  });

  it('replaces the context with the fresh submit-time response', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'contextRequested',
      requestId: 1,
    });
    s = govActionFormReducer(s, {
      kind: 'contextLoaded',
      requestId: 1,
      data: ctx(500, 'a'.repeat(64)),
    });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    s = govActionFormReducer(s, {
      kind: 'contextLoaded',
      requestId: 2,
      data: ctx(501, 'b'.repeat(64)),
    });
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
    expect(s.panels.UpdateCommittee.add).toEqual([
      { input: 'cc_cold1xyz', hexKind: 'key', expiryEpoch: '520' },
    ]);
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
    expect(effectivePrev(null, ctx(500, 'a'.repeat(64)))).toEqual({
      txHashHex: 'a'.repeat(64),
      index: 0,
    });
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
    expect(draft.panels.NewConstitution).toEqual({
      prev: null,
      text: '# Constitution',
      scriptHashHex: '',
    });
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
      state: {
        ...s.panels.UpdateCommittee,
        add: [{ input: 'ab', hexKind: 'key', expiryEpoch: '410' }],
      },
    });
    expect(isFormBlank(s)).toBe(false);
  });

  it('is not blank once the type alone moved away from InfoAction', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setType',
      type: 'NoConfidence',
    });
    expect(isFormBlank(s)).toBe(false);
  });

  it('is not blank once any metadata text is typed', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { abstract: 'x' },
    });
    expect(isFormBlank(s)).toBe(false);
  });
});

const MEMBER_A = 'a'.repeat(56);
const MEMBER_B = 'b'.repeat(56);
const OPEN_HASH = 'f'.repeat(64);

function committeeCtx(): ActionContextResponse {
  return {
    epoch: 500,
    prev: {
      lastEnacted: null,
      open: [
        {
          txHash: OPEN_HASH,
          index: 0,
          id: 'gov_action1open',
          type: 'NewCommittee',
          title: null,
          proposedEpoch: 499,
        },
      ],
    },
    committee: {
      members: [
        { coldHex: MEMBER_A, hasScript: false, expirationEpoch: 600 },
        { coldHex: MEMBER_B, hasScript: false, expirationEpoch: 610 },
      ],
      quorum: { numerator: 2, denominator: 3 },
      maxTermLength: 100,
    },
  };
}

describe('committeeMode and validateCommitteePanel', () => {
  it('is enacted by default and open when the prev is one of the open rows', () => {
    expect(committeeMode(null, committeeCtx())).toBe('enacted');
    expect(committeeMode({ txHashHex: OPEN_HASH, index: 0 }, committeeCtx())).toBe('open');
    expect(committeeMode({ txHashHex: 'c'.repeat(64), index: 0 }, committeeCtx())).toBe('enacted');
  });

  it('builds the validated value from a ticked member and a typed add row', () => {
    const r = validateCommitteePanel(
      {
        prev: null,
        removeHex: [MEMBER_A],
        removeFree: [],
        add: [{ input: MEMBER_B, hexKind: 'key', expiryEpoch: '560' }],
        quorum: { numerator: '2', denominator: '3' },
      },
      committeeCtx(),
    );
    expect(r.errors).toEqual([]);
    expect(r.mode).toBe('enacted');
    expect(r.value).toEqual({
      remove: [{ hashHex: MEMBER_A, isScript: false }],
      add: [{ credential: { hashHex: MEMBER_B, isScript: false }, expiryEpoch: 560 }],
      quorum: { numerator: 2, denominator: 3 },
    });
    // Re-adding a sitting member is a term change, which is a warning only.
    expect(r.warnings).toHaveLength(1);
  });

  it('reports an unparseable credential and a non-numeric epoch on their own fields', () => {
    const r = validateCommitteePanel(
      {
        prev: null,
        removeHex: [],
        removeFree: [],
        add: [
          { input: 'nonsense', hexKind: 'key', expiryEpoch: '560' },
          { input: MEMBER_B, hexKind: 'key', expiryEpoch: 'soon' },
        ],
        quorum: { numerator: '2', denominator: '3' },
      },
      committeeCtx(),
    );
    expect(r.value).toBeNull();
    expect(r.errors.some(e => e.field === 'add[0].credential')).toBe(true);
    expect(r.errors.some(e => e.field === 'add[1].expiryEpoch')).toBe(true);
  });

  it('takes the free remove rows in open mode', () => {
    const r = validateCommitteePanel(
      {
        prev: { txHashHex: OPEN_HASH, index: 0 },
        removeHex: [],
        removeFree: [{ input: 'c'.repeat(56), hexKind: 'script' }],
        add: [],
        quorum: { numerator: '2', denominator: '3' },
      },
      committeeCtx(),
    );
    expect(r.mode).toBe('open');
    expect(r.errors).toEqual([]);
    expect(r.value?.remove).toEqual([{ hashHex: 'c'.repeat(56), isScript: true }]);
  });

  it('carries ticked removals into free rows when the prev switches to an open proposal', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: committeeCtx() });
    s = govActionFormReducer(s, { kind: 'setType', type: 'UpdateCommittee' });
    // setType drops the context, so re-load it for the type now selected.
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 2, data: committeeCtx() });

    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: {
        ...s.panels.UpdateCommittee,
        removeHex: [MEMBER_A, MEMBER_B],
        quorum: { numerator: '1', denominator: '3' },
      },
    });
    expect(committeeMode(s.panels.UpdateCommittee.prev, committeeCtx())).toBe('enacted');

    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: { ...s.panels.UpdateCommittee, prev: { txHashHex: OPEN_HASH, index: 0 } },
    });
    expect(s.panels.UpdateCommittee.removeFree).toEqual([
      { input: MEMBER_A, hexKind: 'key' },
      { input: MEMBER_B, hexKind: 'key' },
    ]);
    // And the built action really carries them, which is what was dropped.
    const r = validateCommitteePanel(s.panels.UpdateCommittee, committeeCtx());
    expect(r.mode).toBe('open');
    expect(r.value?.remove).toEqual([
      { hashHex: MEMBER_A, isScript: false },
      { hashHex: MEMBER_B, isScript: false },
    ]);
  });

  it('keeps the ticked removals on the way back to the enacted default and does not seed twice', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: committeeCtx() });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: {
        ...s.panels.UpdateCommittee,
        removeHex: [MEMBER_A],
        quorum: { numerator: '1', denominator: '3' },
      },
    });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: { ...s.panels.UpdateCommittee, prev: { txHashHex: OPEN_HASH, index: 0 } },
    });
    expect(s.panels.UpdateCommittee.removeFree).toHaveLength(1);

    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: { ...s.panels.UpdateCommittee, prev: null },
    });
    expect(s.panels.UpdateCommittee.removeHex).toEqual([MEMBER_A]);
    const back = validateCommitteePanel(s.panels.UpdateCommittee, committeeCtx());
    expect(back.mode).toBe('enacted');
    expect(back.value?.remove).toEqual([{ hashHex: MEMBER_A, isScript: false }]);

    // Flipping to open again must not duplicate the seeded row.
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: { ...s.panels.UpdateCommittee, prev: { txHashHex: OPEN_HASH, index: 0 } },
    });
    expect(s.panels.UpdateCommittee.removeFree).toHaveLength(1);
  });
});
