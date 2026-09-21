import { describe, it, expect } from 'vitest';
import {
  initialGovActionFormState,
  govActionFormReducer,
  effectivePrev,
  draftFromState,
  isFormBlank,
  committeeMode,
  validateCommitteePanel,
  validateHardForkPanel,
  validateNewConstitutionPanel,
  PREV_ACTION_CHANGED,
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

describe('setPanel on HardForkInitiation', () => {
  it('drops a version chosen against an open prev once the prev switches', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'setType', type: 'HardForkInitiation' });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'HardForkInitiation',
      state: { prev: REF_A, version: { major: 11, minor: 0 } },
    });
    expect(s.panels.HardForkInitiation.version).toEqual({ major: 11, minor: 0 });

    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'HardForkInitiation',
      state: { prev: REF_B, version: { major: 11, minor: 0 } },
    });
    expect(s.panels.HardForkInitiation.prev).toEqual(REF_B);
    expect(s.panels.HardForkInitiation.version).toBeNull();
  });

  it('keeps the version when the panel state changes but the prev does not', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'setType', type: 'HardForkInitiation' });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'HardForkInitiation',
      state: { prev: REF_A, version: { major: 11, minor: 0 } },
    });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'HardForkInitiation',
      state: { prev: REF_A, version: { major: 11, minor: 0 } },
    });
    expect(s.panels.HardForkInitiation.version).toEqual({ major: 11, minor: 0 });
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
        { coldHex: MEMBER_A, hasScript: false, expirationEpoch: 600, name: null },
        { coldHex: MEMBER_B, hasScript: false, expirationEpoch: 610, name: null },
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

describe('validateHardForkPanel', () => {
  const OPEN_ROW = {
    txHash: 'b'.repeat(64),
    index: 1,
    id: 'gov_action1yyyy',
    type: 'HardForkInitiation',
    title: null,
    proposedEpoch: 500,
    version: { major: 10, minor: 1 },
  };

  function hfCtx(overrides: Partial<ActionContextResponse> = {}): ActionContextResponse {
    return {
      epoch: 500,
      prev: { lastEnacted: null, open: [OPEN_ROW] },
      protocolVersion: { major: 10, minor: 0 },
      ...overrides,
    };
  }

  it('accepts a version that follows the active one when chaining onto the root', () => {
    const result = validateHardForkPanel({ prev: null, version: { major: 11, minor: 0 } }, hfCtx());
    expect(result).toEqual({ ok: true, value: { major: 11, minor: 0 } });
  });

  it('accepts a version that follows the chosen open proposal', () => {
    const prev = { txHashHex: 'b'.repeat(64), index: 1 };
    const result = validateHardForkPanel({ prev, version: { major: 10, minor: 2 } }, hfCtx());
    expect(result).toEqual({ ok: true, value: { major: 10, minor: 2 } });
  });

  it('asks for a version when none is picked', () => {
    const result = validateHardForkPanel({ prev: null, version: null }, hfCtx());
    expect(result).toEqual({ ok: false, error: 'Choose the protocol version to propose.' });
  });

  it('refuses when the active protocol version could not be read', () => {
    const result = validateHardForkPanel(
      { prev: null, version: { major: 11, minor: 0 } },
      hfCtx({ protocolVersion: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('current protocol version could not be read');
  });

  it('refuses when the chosen open proposal carries no readable version', () => {
    const prev = { txHashHex: 'b'.repeat(64), index: 1 };
    const ctxNoVersion = hfCtx({
      prev: { lastEnacted: null, open: [{ ...OPEN_ROW, version: undefined }] },
    });
    const result = validateHardForkPanel({ prev, version: { major: 10, minor: 2 } }, ctxNoVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('could not be read, so no version can be proposed');
  });

  it('refuses a version that no longer follows the chain state', () => {
    const result = validateHardForkPanel({ prev: null, version: { major: 12, minor: 0 } }, hfCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        `Protocol version 12.0 no longer follows the current chain state. ${PREV_ACTION_CHANGED}`,
      );
    }
  });
});

describe('validateNewConstitutionPanel', () => {
  const HASH = 'a'.repeat(56);

  function ncCtx(scriptHash: string | null): ActionContextResponse {
    return { epoch: 500, prev: { lastEnacted: null, open: [] }, constitution: { scriptHash } };
  }

  it('falls back to the hash in force while the field is untouched', () => {
    const result = validateNewConstitutionPanel(
      { prev: null, text: '# Constitution', scriptHashHex: null },
      ncCtx(HASH),
    );
    expect(result).toEqual({ ok: true, value: { text: '# Constitution', scriptHashHex: HASH } });
  });

  it('lowercases a typed hash and takes a deliberately cleared field as no script', () => {
    const upper = validateNewConstitutionPanel(
      { prev: null, text: 'text', scriptHashHex: 'A'.repeat(56) },
      ncCtx(null),
    );
    expect(upper).toEqual({ ok: true, value: { text: 'text', scriptHashHex: HASH } });

    const cleared = validateNewConstitutionPanel(
      { prev: null, text: 'text', scriptHashHex: '' },
      ncCtx(HASH),
    );
    expect(cleared).toEqual({ ok: true, value: { text: 'text', scriptHashHex: null } });
  });

  it('asks for the constitution text when it is empty or whitespace', () => {
    const result = validateNewConstitutionPanel({ prev: null, text: '   ', scriptHashHex: null }, ncCtx(null));
    expect(result).toEqual({ ok: false, error: 'Enter the constitution text.' });
  });

  it('refuses a document over the byte cap', () => {
    const tooBig = 'x'.repeat(256 * 1024 + 1);
    const result = validateNewConstitutionPanel({ prev: null, text: tooBig, scriptHashHex: null }, ncCtx(null));
    expect(result).toEqual({ ok: false, error: 'The constitution document is over the 256 KiB limit.' });
  });

  it('refuses a guardrails hash that is not 56 hex characters', () => {
    const result = validateNewConstitutionPanel(
      { prev: null, text: 'text', scriptHashHex: 'nope' },
      ncCtx(null),
    );
    expect(result).toEqual({ ok: false, error: 'A guardrails script hash is exactly 56 hex characters.' });
  });
});

describe('wallet state', () => {
  it('starts with no wallet and a clean form', () => {
    const s = initialGovActionFormState();
    expect(s.wallet).toEqual({ status: 'none' });
    expect(s.dirty).toBe(false);
  });

  it('walks none, connecting, connected with a loading balance', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    expect(s.wallet).toEqual({ status: 'connecting' });
    s = govActionFormReducer(s, { kind: 'walletConnected', rewardAddressHex: 'e0ff' });
    expect(s.wallet).toEqual({
      status: 'connected',
      rewardAddressHex: 'e0ff',
      balance: { status: 'loading' },
    });
  });

  it('ignores a second connect while one is running', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    const again = govActionFormReducer(s, { kind: 'walletConnecting' });
    expect(again).toBe(s);
  });

  it('files the balance read, its result and its failure', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    s = govActionFormReducer(s, { kind: 'walletConnected', rewardAddressHex: 'e0ff' });
    s = govActionFormReducer(s, { kind: 'walletBalance', lovelace: 42n });
    expect(s.wallet).toEqual({
      status: 'connected',
      rewardAddressHex: 'e0ff',
      balance: { status: 'ready', lovelace: 42n },
    });
    s = govActionFormReducer(s, { kind: 'walletBalanceLoading' });
    expect(s.wallet).toEqual({
      status: 'connected',
      rewardAddressHex: 'e0ff',
      balance: { status: 'loading' },
    });
    s = govActionFormReducer(s, { kind: 'walletBalanceFailed', message: 'Koios said no' });
    expect(s.wallet).toEqual({
      status: 'connected',
      rewardAddressHex: 'e0ff',
      balance: { status: 'error', message: 'Koios said no' },
    });
  });

  it('ignores a balance action while no wallet is connected', () => {
    const s = initialGovActionFormState();
    expect(govActionFormReducer(s, { kind: 'walletBalance', lovelace: 1n })).toBe(s);
    expect(govActionFormReducer(s, { kind: 'walletBalanceLoading' })).toBe(s);
    expect(govActionFormReducer(s, { kind: 'walletBalanceFailed', message: 'x' })).toBe(s);
  });

  it('drops the reward address and the balance on disconnect', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    s = govActionFormReducer(s, { kind: 'walletConnected', rewardAddressHex: 'e0ff' });
    s = govActionFormReducer(s, { kind: 'walletBalance', lovelace: 42n });
    // "Use a different wallet" after a failed submit.
    s = govActionFormReducer(s, { kind: 'walletDisconnected' });
    expect(s.wallet).toEqual({ status: 'none' });
  });

  it('goes back to none when the connect attempt finds no reward address', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    s = govActionFormReducer(s, { kind: 'walletDisconnected' });
    expect(s.wallet).toEqual({ status: 'none' });
  });

  it('keeps the form untouched across every wallet transition', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { title: 'Keep me' } });
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    s = govActionFormReducer(s, { kind: 'walletConnected', rewardAddressHex: 'e0ff' });
    s = govActionFormReducer(s, { kind: 'walletDisconnected' });
    expect(s.metadata.title).toBe('Keep me');
    expect(s.type).toBe('InfoAction');
  });
});

describe('dirty', () => {
  it('is set by a metadata edit', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { title: 'x' },
    });
    expect(s.dirty).toBe(true);
  });

  it('is set by the author fields, which live in the metadata', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { signAsAuthor: true },
    });
    expect(s.dirty).toBe(true);
    s = { ...s, dirty: false };
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { authorName: 'Someone' } });
    expect(s.dirty).toBe(true);
  });

  it('is set by a type switch, but not by re-picking the same type', () => {
    let s = govActionFormReducer(initialGovActionFormState(), { kind: 'setType', type: 'NoConfidence' });
    expect(s.dirty).toBe(true);
    s = { ...s, dirty: false };
    s = govActionFormReducer(s, { kind: 'setType', type: 'NoConfidence' });
    expect(s.dirty).toBe(false);
  });

  it('is set by a panel edit', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setPanel',
      type: 'NoConfidence',
      state: { prev: REF_A },
    });
    expect(s.dirty).toBe(true);
  });

  it('is cleared by a draft restore', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { title: 'x' },
    });
    const draft: GovActionDraft = {
      v: 2,
      type: 'InfoAction',
      title: 'T',
      abstract: '',
      motivation: '',
      rationale: '',
      signAsAuthor: false,
      authorName: '',
      references: [],
      surveyRef: '',
      panels: {},
    };
    s = govActionFormReducer(s, { kind: 'restoreDraft', draft });
    expect(s.dirty).toBe(false);
  });

  it('is untouched by the context lifecycle and by the wallet', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextFailed', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    s = govActionFormReducer(s, { kind: 'walletConnected', rewardAddressHex: 'e0ff' });
    expect(s.dirty).toBe(false);
  });
});
