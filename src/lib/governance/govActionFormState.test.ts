import { describe, it, expect } from 'vitest';
import {
  initialGovActionFormState,
  govActionFormReducer,
  effectivePrev,
  draftFromState,
  isFormBlank,
  linkedDraftReference,
  effectiveLinkedDraftSlug,
  draftConflict,
  committeeMode,
  validateCommitteePanel,
  validateHardForkPanel,
  validateNewConstitutionPanel,
  contextChangeLines,
  PREV_ACTION_CHANGED,
  type GovActionFormState,
} from './govActionFormState.js';
import type { ActionContextResponse } from './actionContextHandler.js';
import type { GovActionDraft } from './govActionDraft.js';
import { REFERENCES_MAX } from './infoActionLimits.js';

const REF_A = { txHashHex: 'a'.repeat(64), index: 0 };
const REF_B = { txHashHex: 'b'.repeat(64), index: 1 };
const SITE_ORIGIN = 'https://dreptalk.com';

/** A stored v2 draft with every field on its empty default, for the restore paths. */
function draft(overrides: Partial<GovActionDraft> = {}): GovActionDraft {
  return {
    v: 2,
    type: 'InfoAction',
    title: '',
    abstract: '',
    motivation: '',
    rationale: '',
    signAsAuthor: true,
    authorName: '',
    references: [],
    surveyRef: '',
    panels: {},
    ...overrides,
  };
}

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
  it('starts on InfoAction with empty metadata text, empty panels and an idle context', () => {
    const s = initialGovActionFormState();
    expect(s.type).toBe('InfoAction');
    expect(s.metadata.title).toBe('');
    expect(s.metadata.references).toEqual([]);
    expect(s.panels.UpdateCommittee.add).toEqual([]);
    expect(s.context.status).toBe('idle');
    expect(s.context.data).toBeNull();
  });

  it('signs as author by default, with no name when none is given', () => {
    const s = initialGovActionFormState();
    expect(s.metadata.signAsAuthor).toBe(true);
    expect(s.metadata.authorName).toBe('');
  });

  it('prefills the author name from the signed-in display name', () => {
    const s = initialGovActionFormState('Jane DRep');
    expect(s.metadata.signAsAuthor).toBe(true);
    expect(s.metadata.authorName).toBe('Jane DRep');
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
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(500), now: 0 });
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
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 3, data: ctx(501), now: 0 });
    expect(s.context.status).toBe('ready');
    expect(s.context.data?.epoch).toBe(501);
  });

  it('ignores an out-of-order response from a superseded request', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'setType', type: 'HardForkInitiation' });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    // The slow response for the first (NoConfidence-era) request arrives late.
    const after = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(400), now: 0 });
    expect(after).toBe(s);
    expect(after.context.status).toBe('loading');
    expect(after.context.data).toBeNull();
  });

  it('ignores a stale failure the same way', () => {
    let s = initialGovActionFormState();
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 2, data: ctx(502), now: 0 });
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
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(500), now: 0 });
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
      now: 0,
    });
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    s = govActionFormReducer(s, {
      kind: 'contextLoaded',
      requestId: 2,
      data: ctx(501, 'b'.repeat(64)),
      now: 60_000,
    });
    expect(s.context.status).toBe('ready');
    expect(s.context.data?.epoch).toBe(501);
    expect(s.context.data?.prev?.lastEnacted?.txHash).toBe('b'.repeat(64));
  });
});

// A context with every field the change notes compare, so each test below
// only overrides the one field it moves. `undefined` keeps the base value,
// an explicit `null` clears the field (no previous action, no script hash).
function changeCtx(over: {
  lastEnactedId?: string | null;
  quorum?: { numerator: number; denominator: number } | null;
  scriptHash?: string | null;
  version?: { major: number; minor: number } | null;
} = {}): ActionContextResponse {
  const lastEnactedId = over.lastEnactedId === undefined ? 'gov_action1aaa' : over.lastEnactedId;
  return {
    epoch: 500,
    prev: {
      lastEnacted: lastEnactedId
        ? { txHash: 'a'.repeat(64), index: 0, id: lastEnactedId, type: 'NewConstitution', title: null, proposedEpoch: 100 }
        : null,
      open: [],
    },
    committee: {
      members: [],
      quorum: over.quorum === undefined ? { numerator: 2, denominator: 3 } : over.quorum,
      maxTermLength: null,
    },
    constitution: { scriptHash: over.scriptHash === undefined ? 'f'.repeat(56) : over.scriptHash },
    protocolVersion: (over.version === undefined ? { major: 11, minor: 0 } : over.version) ?? undefined,
  };
}

/** Loads `data` as the very next ready response, starting from a fresh idle state. */
function loadOnce(data: ActionContextResponse, now = 0): GovActionFormState {
  let s = initialGovActionFormState();
  s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
  return govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data, now });
}

/** Refetches over an already-ready state, so contextLoaded has something to compare against. */
function reload(s: GovActionFormState, data: ActionContextResponse, now: number): GovActionFormState {
  s = govActionFormReducer(s, { kind: 'contextRequested', requestId: s.context.requestId + 1 });
  return govActionFormReducer(s, { kind: 'contextLoaded', requestId: s.context.requestId, data, now });
}

describe('contextLoaded change notes', () => {
  it('produces no changes on a first load, there is nothing yet to compare against', () => {
    const s = loadOnce(changeCtx());
    expect(contextChangeLines(s.context.changes)).toEqual([]);
  });

  it('sets loadedAt from the action’s own now, not the clock', () => {
    const s = loadOnce(changeCtx(), 123_456);
    expect(s.context.loadedAt).toBe(123_456);
  });

  it('notes the previous action moving to a different one', () => {
    let s = loadOnce(changeCtx({ lastEnactedId: 'gov_action1aaa' }));
    s = reload(s, changeCtx({ lastEnactedId: 'gov_action1bbb' }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The previous action changed to gov_action1bbb']);
  });

  it('notes the previous action moving to none', () => {
    let s = loadOnce(changeCtx({ lastEnactedId: 'gov_action1aaa' }));
    s = reload(s, changeCtx({ lastEnactedId: null }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual([
      'The previous action changed to none, this now starts the chain',
    ]);
  });

  it('notes the committee quorum changing', () => {
    let s = loadOnce(changeCtx({ quorum: { numerator: 2, denominator: 3 } }));
    s = reload(s, changeCtx({ quorum: { numerator: 3, denominator: 5 } }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The committee quorum changed to 3/5']);
  });

  it('notes the guardrails script hash changing, shortened the way the on-chain card shortens it', () => {
    const newHash = 'b'.repeat(56);
    let s = loadOnce(changeCtx({ scriptHash: 'f'.repeat(56) }));
    s = reload(s, changeCtx({ scriptHash: newHash }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual([
      `The guardrails script hash changed to ${newHash.slice(0, 8)}…${newHash.slice(-6)}`,
    ]);
  });

  it('notes the guardrails script hash going missing', () => {
    let s = loadOnce(changeCtx({ scriptHash: 'f'.repeat(56) }));
    s = reload(s, changeCtx({ scriptHash: null }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The guardrails script hash is no longer on record']);
  });

  it('notes the active protocol version changing', () => {
    let s = loadOnce(changeCtx({ version: { major: 11, minor: 0 } }));
    s = reload(s, changeCtx({ version: { major: 11, minor: 1 } }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The active protocol version changed to 11.1']);
  });

  it('lists every field that moved at once, in one refetch', () => {
    let s = loadOnce(
      changeCtx({ lastEnactedId: 'gov_action1aaa', quorum: { numerator: 2, denominator: 3 }, scriptHash: 'f'.repeat(56), version: { major: 11, minor: 0 } }),
    );
    s = reload(
      s,
      changeCtx({ lastEnactedId: 'gov_action1bbb', quorum: { numerator: 3, denominator: 5 }, scriptHash: null, version: { major: 12, minor: 0 } }),
      1000,
    );
    expect(contextChangeLines(s.context.changes)).toEqual([
      'The previous action changed to gov_action1bbb',
      'The committee quorum changed to 3/5',
      'The guardrails script hash is no longer on record',
      'The active protocol version changed to 12.0',
    ]);
  });

  it('reports no changes when a refetch answers with the same reading', () => {
    let s = loadOnce(changeCtx());
    s = reload(s, changeCtx(), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual([]);
  });

  // Finding 2 (Codex, review round 2): a wholesale replacement on every
  // refetch loses an earlier note the moment ANY refetch runs, even one that
  // does not touch the field the note was about. These two tests exercise
  // exactly the sequence the design promises: a note stays until an edit,
  // not until the next unrelated network round trip.
  it('keeps a note through a refetch that changes nothing, and drops it only on the next edit', () => {
    let s = loadOnce(changeCtx({ quorum: { numerator: 2, denominator: 3 } }));
    s = reload(s, changeCtx({ quorum: { numerator: 3, denominator: 5 } }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The committee quorum changed to 3/5']);

    // An unrelated refetch (nothing moved) must not touch the existing note.
    s = reload(s, changeCtx({ quorum: { numerator: 3, denominator: 5 } }), 2000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The committee quorum changed to 3/5']);

    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { title: 'an edit' } });
    expect(contextChangeLines(s.context.changes)).toEqual([]);
  });

  it('accumulates notes from different fields moving on successive refetches, not just one refetch at once', () => {
    let s = loadOnce(changeCtx({ quorum: { numerator: 2, denominator: 3 }, scriptHash: 'f'.repeat(56) }));
    s = reload(s, changeCtx({ quorum: { numerator: 3, denominator: 5 }, scriptHash: 'f'.repeat(56) }), 1000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The committee quorum changed to 3/5']);

    // A LATER refetch moves a different field. The quorum note from the
    // earlier refetch must still be there, in the fixed rendering order.
    const newHash = 'b'.repeat(56);
    s = reload(s, changeCtx({ quorum: { numerator: 3, denominator: 5 }, scriptHash: newHash }), 2000);
    expect(contextChangeLines(s.context.changes)).toEqual([
      'The committee quorum changed to 3/5',
      `The guardrails script hash changed to ${newHash.slice(0, 8)}…${newHash.slice(-6)}`,
    ]);
  });

  it('replaces a field’s own note when that same field moves again, rather than keeping the stale one', () => {
    let s = loadOnce(changeCtx({ quorum: { numerator: 2, denominator: 3 } }));
    s = reload(s, changeCtx({ quorum: { numerator: 3, denominator: 5 } }), 1000);
    s = reload(s, changeCtx({ quorum: { numerator: 1, denominator: 2 } }), 2000);
    expect(contextChangeLines(s.context.changes)).toEqual(['The committee quorum changed to 1/2']);
  });

  it('clears on setType, since the context itself is dropped', () => {
    let s = loadOnce(changeCtx({ lastEnactedId: 'gov_action1aaa' }));
    s = reload(s, changeCtx({ lastEnactedId: 'gov_action1bbb' }), 1000);
    expect(contextChangeLines(s.context.changes)).not.toEqual([]);
    s = govActionFormReducer(s, { kind: 'setType', type: 'NewConstitution' });
    expect(contextChangeLines(s.context.changes)).toEqual([]);
  });

  it('clears on setMetadata, setPanel, linkDraft and unlinkDraft, the form’s own edit actions', () => {
    const withChanges = () => {
      let s = loadOnce(changeCtx({ lastEnactedId: 'gov_action1aaa' }));
      s = reload(s, changeCtx({ lastEnactedId: 'gov_action1bbb' }), 1000);
      expect(contextChangeLines(s.context.changes)).not.toEqual([]);
      return s;
    };

    expect(
      contextChangeLines(govActionFormReducer(withChanges(), { kind: 'setMetadata', patch: { title: 'x' } }).context.changes),
    ).toEqual([]);

    expect(
      contextChangeLines(
        govActionFormReducer(withChanges(), {
          kind: 'setPanel',
          type: 'NoConfidence',
          state: { prev: null },
        }).context.changes,
      ),
    ).toEqual([]);

    expect(
      contextChangeLines(
        govActionFormReducer(withChanges(), {
          kind: 'linkDraft',
          slug: 'a-draft',
          title: 'A draft',
          siteOrigin: SITE_ORIGIN,
        }).context.changes,
      ),
    ).toEqual([]);

    let linked = govActionFormReducer(withChanges(), {
      kind: 'linkDraft',
      slug: 'a-draft',
      title: 'A draft',
      siteOrigin: SITE_ORIGIN,
    });
    linked = reload(linked, changeCtx({ lastEnactedId: 'gov_action1ccc' }), 2000);
    expect(contextChangeLines(linked.context.changes)).not.toEqual([]);
    expect(
      contextChangeLines(govActionFormReducer(linked, { kind: 'unlinkDraft', siteOrigin: SITE_ORIGIN }).context.changes),
    ).toEqual([]);
  });

  it('clears on discardDraft too, so a discarded draft leaves no stale notes behind', () => {
    let s = loadOnce(changeCtx({ lastEnactedId: 'gov_action1aaa' }));
    s = reload(s, changeCtx({ lastEnactedId: 'gov_action1bbb' }), 1000);
    expect(contextChangeLines(s.context.changes)).not.toEqual([]);

    s = govActionFormReducer(s, { kind: 'discardDraft', displayName: 'Jane DRep' });
    expect(contextChangeLines(s.context.changes)).toEqual([]);
    // The context reading itself (and its age) is not draft data, unlike the
    // notes: discarding text is not the same as losing the chain reading.
    expect(s.context.status).toBe('ready');
    expect(s.context.loadedAt).toBe(1000);
  });

  it('keeps the previous changes visible while a same-type refetch is in flight', () => {
    let s = loadOnce(changeCtx({ lastEnactedId: 'gov_action1aaa' }));
    s = reload(s, changeCtx({ lastEnactedId: 'gov_action1bbb' }), 1000);
    const withChanges = s.context.changes;
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: s.context.requestId + 1 });
    expect(s.context.status).toBe('loading');
    expect(s.context.changes).toEqual(withChanges);
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

  const baseDraft: GovActionDraft = {
    v: 2,
    type: 'InfoAction',
    title: '',
    abstract: '',
    motivation: '',
    rationale: '',
    signAsAuthor: false,
    authorName: '',
    references: [],
    surveyRef: '',
    panels: {},
  };

  it('restores an explicit tracked slug', () => {
    const draft: GovActionDraft = { ...baseDraft, linkedDraftSlug: 'my-draft-a1b2' };
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'restoreDraft', draft });
    expect(s.linkedDraftSlug).toBe('my-draft-a1b2');
  });

  it('restores an explicit null tracked slug (linked then unlinked) without deriving one', () => {
    const draft: GovActionDraft = {
      ...baseDraft,
      linkedDraftSlug: null,
      references: [{ label: 'A draft', uri: `${SITE_ORIGIN}/t/still-open-a1/` }],
    };
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'restoreDraft',
      draft,
      openDrafts: [{ slug: 'still-open-a1' }],
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBeNull();
  });

  it('derives the tracked slug of a legacy draft (no stored linkedDraftSlug) from the first reference naming an open draft', () => {
    const draft: GovActionDraft = {
      ...baseDraft,
      references: [
        { label: 'Not a draft', uri: 'https://example.org/notes' },
        { label: 'My draft', uri: `${SITE_ORIGIN}/t/legacy-draft-c3/` },
      ],
    };
    expect(draft.linkedDraftSlug).toBeUndefined();
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'restoreDraft',
      draft,
      openDrafts: [{ slug: 'legacy-draft-c3' }],
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBe('legacy-draft-c3');
    // The rows themselves are untouched, but the derived one is moved to the
    // front like any tracked reference, see draftReferenceFirst.
    expect(s.metadata.references).toEqual([
      { label: 'My draft', uri: `${SITE_ORIGIN}/t/legacy-draft-c3/` },
      { label: 'Not a draft', uri: 'https://example.org/notes' },
    ]);
  });

  it('leaves the tracked slug null for a legacy draft whose references name no open draft', () => {
    const draft: GovActionDraft = {
      ...baseDraft,
      references: [{ label: 'A closed thread', uri: `${SITE_ORIGIN}/t/no-longer-open/` }],
    };
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'restoreDraft',
      draft,
      openDrafts: [{ slug: 'some-other-draft' }],
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBeNull();
  });

  it('keeps an explicit tracked slug and its reference even once the draft is no longer open', () => {
    const draft: GovActionDraft = {
      ...baseDraft,
      linkedDraftSlug: 'closed-draft-f9',
      references: [{ label: 'Closed draft', uri: `${SITE_ORIGIN}/t/closed-draft-f9/` }],
    };
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'restoreDraft',
      draft,
      openDrafts: [],
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBe('closed-draft-f9');
    expect(s.metadata.references).toEqual(draft.references);
  });

  it('drops a malformed stored slug instead of tracking it', () => {
    const draft: GovActionDraft = {
      ...baseDraft,
      // Not a slugify() shape (see forum.ts): corrupted or tampered storage,
      // never a value this app wrote.
      linkedDraftSlug: '../etc/passwd',
      references: [{ label: 'Suspicious', uri: `${SITE_ORIGIN}/t/../etc/passwd/` }],
    };
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'restoreDraft', draft });
    expect(s.linkedDraftSlug).toBeNull();
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
    expect(isFormBlank(initialGovActionFormState(), { authorName: '' })).toBe(true);
  });

  it('treats the prefilled author name and the default signing-on as blank too', () => {
    expect(isFormBlank(initialGovActionFormState('Jane DRep'), { authorName: 'Jane DRep' })).toBe(true);
  });

  it('is not blank once the author name is edited away from the default', () => {
    const s = govActionFormReducer(initialGovActionFormState('Jane DRep'), {
      kind: 'setMetadata',
      patch: { authorName: 'Someone else' },
    });
    expect(isFormBlank(s, { authorName: 'Jane DRep' })).toBe(false);
  });

  it('is not blank once signing as author is turned off, even with the name untouched', () => {
    const s = govActionFormReducer(initialGovActionFormState('Jane DRep'), {
      kind: 'setMetadata',
      patch: { signAsAuthor: false },
    });
    expect(isFormBlank(s, { authorName: 'Jane DRep' })).toBe(false);
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
    expect(isFormBlank(s, { authorName: '' })).toBe(false);
  });

  it('is not blank once the type alone moved away from InfoAction', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setType',
      type: 'NoConfidence',
    });
    expect(isFormBlank(s, { authorName: '' })).toBe(false);
  });

  it('is not blank once any metadata text is typed', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { abstract: 'x' },
    });
    expect(isFormBlank(s, { authorName: '' })).toBe(false);
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
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: committeeCtx(), now: 0 });
    s = govActionFormReducer(s, { kind: 'setType', type: 'UpdateCommittee' });
    // setType drops the context, so re-load it for the type now selected.
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 2 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 2, data: committeeCtx(), now: 0 });

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
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: committeeCtx(), now: 0 });
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

describe('discardDraft', () => {
  it('resets the type, metadata and panels to the defaults and clears dirty', () => {
    let s = initialGovActionFormState('Jane DRep');
    s = govActionFormReducer(s, { kind: 'setType', type: 'UpdateCommittee' });
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { title: 'Draft title', authorName: 'Someone else' } });
    s = govActionFormReducer(s, {
      kind: 'setPanel',
      type: 'UpdateCommittee',
      state: { ...s.panels.UpdateCommittee, add: [{ input: 'ab', hexKind: 'key', expiryEpoch: '410' }] },
    });
    expect(s.dirty).toBe(true);

    s = govActionFormReducer(s, { kind: 'discardDraft', displayName: 'Jane DRep' });
    expect(s.type).toBe('InfoAction');
    expect(s.metadata).toEqual({
      title: '',
      abstract: '',
      motivation: '',
      rationale: '',
      signAsAuthor: true,
      authorName: 'Jane DRep',
      references: [],
      surveyRef: '',
    });
    expect(s.panels.UpdateCommittee.add).toEqual([]);
    expect(s.dirty).toBe(false);
  });

  it('leaves the context and the wallet untouched', () => {
    let s = initialGovActionFormState('Jane DRep');
    s = govActionFormReducer(s, { kind: 'contextRequested', requestId: 1 });
    s = govActionFormReducer(s, { kind: 'contextLoaded', requestId: 1, data: ctx(500), now: 0 });
    s = govActionFormReducer(s, { kind: 'walletConnecting' });
    s = govActionFormReducer(s, { kind: 'walletConnected', rewardAddressHex: 'e0ff' });

    s = govActionFormReducer(s, { kind: 'discardDraft', displayName: 'Jane DRep' });
    expect(s.context.status).toBe('ready');
    expect(s.wallet).toEqual({ status: 'connected', rewardAddressHex: 'e0ff', balance: { status: 'loading' } });
  });

  it('leaves the form blank straight after discarding', () => {
    let s = initialGovActionFormState('Jane DRep');
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { title: 'x' } });
    s = govActionFormReducer(s, { kind: 'discardDraft', displayName: 'Jane DRep' });
    expect(isFormBlank(s, { authorName: 'Jane DRep' })).toBe(true);
  });

  it('clears the tracked draft slug', () => {
    let s = initialGovActionFormState('Jane DRep');
    s = govActionFormReducer(s, { kind: 'linkDraft', slug: 'a-draft', title: 'A draft', siteOrigin: SITE_ORIGIN });
    s = govActionFormReducer(s, { kind: 'discardDraft', displayName: 'Jane DRep' });
    expect(s.linkedDraftSlug).toBeNull();
    expect(s.metadata.references).toEqual([]);
  });
});

// resolveDraftTopic (draftLinks.ts) reads the FIRST Proposal Drafts reference
// of a submitted document, so the tracked draft's reference has to stay at the
// front through every path, not only through linkDraft's own insert.
describe('the tracked draft reference stays first', () => {
  it('moves a restored tracked reference ahead of an earlier closed-draft reference', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'restoreDraft',
      draft: draft({
        references: [
          { label: 'Closed draft C', uri: `${SITE_ORIGIN}/t/closed-draft-c/` },
          { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
          { label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` },
        ],
        linkedDraftSlug: 'draft-a',
      }),
      openDrafts: [{ slug: 'draft-a' }],
      siteOrigin: SITE_ORIGIN,
    });

    expect(s.linkedDraftSlug).toBe('draft-a');
    expect(s.metadata.references).toEqual([
      { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
      { label: 'Closed draft C', uri: `${SITE_ORIGIN}/t/closed-draft-c/` },
      { label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` },
    ]);
    // The restore itself is not an edit, moving the row does not make it one.
    expect(s.dirty).toBe(false);
  });

  it('moves the tracked reference back to the front when an edit pushes it behind another row', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    s = govActionFormReducer(s, {
      kind: 'setMetadata',
      patch: {
        references: [
          { label: 'Closed draft C', uri: `${SITE_ORIGIN}/t/closed-draft-c/` },
          { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
        ],
      },
      siteOrigin: SITE_ORIGIN,
    });

    expect(s.linkedDraftSlug).toBe('draft-a');
    expect(s.metadata.references).toEqual([
      { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
      { label: 'Closed draft C', uri: `${SITE_ORIGIN}/t/closed-draft-c/` },
    ]);
  });

  it('leaves the order alone for an edit that does not move the tracked reference', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    s = govActionFormReducer(s, {
      kind: 'setMetadata',
      patch: { references: [...s.metadata.references, { label: 'Other', uri: 'https://example.org/x' }] },
      siteOrigin: SITE_ORIGIN,
    });
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { title: 'A title' }, siteOrigin: SITE_ORIGIN });

    expect(s.metadata.references).toEqual([
      { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
      { label: 'Other', uri: 'https://example.org/x' },
    ]);
  });

  it('leaves a restored draft alone when nothing is tracked', () => {
    const references = [
      { label: 'Closed draft C', uri: `${SITE_ORIGIN}/t/closed-draft-c/` },
      { label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` },
    ];
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'restoreDraft',
      draft: draft({ references, linkedDraftSlug: null }),
      openDrafts: [{ slug: 'draft-a' }],
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.metadata.references).toEqual(references);
  });
});

describe('linkDraft', () => {
  it('appends a reference in the exact shape draftSlugsFromReferences recognizes', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'fund-tooling-a1b2',
      title: 'Fund tooling',
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBe('fund-tooling-a1b2');
    expect(s.metadata.references).toEqual([
      { label: 'Fund tooling', uri: `${SITE_ORIGIN}/t/fund-tooling-a1b2/` },
    ]);
    expect(s.dirty).toBe(true);
    expect(s.draftLinkError).toBeNull();
  });

  it('replaces the tracked reference when switching drafts, leaving an unrelated thread reference untouched', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { references: [{ label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` }] },
    });
    s = govActionFormReducer(s, { kind: 'linkDraft', slug: 'draft-a', title: 'Draft A', siteOrigin: SITE_ORIGIN });
    // Inserted at the front, ahead of the unrelated reference: gov-sync's
    // resolver takes the first Proposal Drafts reference in order, so the
    // picked draft has to outrank whatever else is already listed.
    expect(s.metadata.references).toEqual([
      { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
      { label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` },
    ]);

    s = govActionFormReducer(s, { kind: 'linkDraft', slug: 'draft-b', title: 'Draft B', siteOrigin: SITE_ORIGIN });
    expect(s.linkedDraftSlug).toBe('draft-b');
    // The replacement is at the front too, the unrelated reference is still
    // untouched.
    expect(s.metadata.references).toEqual([
      { label: 'Draft B', uri: `${SITE_ORIGIN}/t/draft-b/` },
      { label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` },
    ]);
  });

  it('inserts the picked draft ahead of an earlier reference naming a closed draft, so it stays the first Proposal Drafts reference', () => {
    // Nothing is tracked here on purpose: this is the shape a manually typed
    // reference to an old, now-locked draft leaves behind, which is exactly
    // what resolveDraftTopic (draftLinks.ts) would otherwise read first.
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: {
        references: [
          { label: 'Closed draft A', uri: `${SITE_ORIGIN}/t/closed-draft-a/` },
          { label: 'Unrelated', uri: `${SITE_ORIGIN}/t/unrelated-thread/` },
        ],
      },
    });
    s = govActionFormReducer(s, { kind: 'linkDraft', slug: 'draft-b', title: 'Draft B', siteOrigin: SITE_ORIGIN });
    expect(s.linkedDraftSlug).toBe('draft-b');
    expect(s.metadata.references).toEqual([
      { label: 'Draft B', uri: `${SITE_ORIGIN}/t/draft-b/` },
      { label: 'Closed draft A', uri: `${SITE_ORIGIN}/t/closed-draft-a/` },
      { label: 'Unrelated', uri: `${SITE_ORIGIN}/t/unrelated-thread/` },
    ]);
  });

  it('replaces the tracked reference in place even when the list is at the cap', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    const filler = Array.from({ length: REFERENCES_MAX - 1 }, (_, i) => ({ label: `R${i}`, uri: `https://example.org/${i}` }));
    s = govActionFormReducer(s, {
      kind: 'setMetadata',
      patch: { references: [...s.metadata.references, ...filler] },
    });
    expect(s.metadata.references).toHaveLength(REFERENCES_MAX);

    s = govActionFormReducer(s, { kind: 'linkDraft', slug: 'draft-b', title: 'Draft B', siteOrigin: SITE_ORIGIN });
    expect(s.linkedDraftSlug).toBe('draft-b');
    expect(s.metadata.references).toHaveLength(REFERENCES_MAX);
    expect(s.metadata.references[0]).toEqual({ label: 'Draft B', uri: `${SITE_ORIGIN}/t/draft-b/` });
    expect(s.draftLinkError).toBeNull();
  });

  it('moves a replaced reference to the front, ahead of an earlier closed-draft reference', () => {
    // The shape a restored draft leaves behind: a reference to a draft that
    // has since been closed sits ahead of the tracked one. Rewriting the
    // tracked row where it stood would leave the closed draft first, and
    // resolveDraftTopic (draftLinks.ts) reads the first Proposal Drafts
    // reference, not the one the picker shows.
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'restoreDraft',
      draft: draft({
        references: [
          { label: 'Closed draft C', uri: `${SITE_ORIGIN}/t/closed-draft-c/` },
          { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
        ],
        linkedDraftSlug: 'draft-a',
      }),
      openDrafts: [{ slug: 'draft-a' }, { slug: 'draft-b' }],
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBe('draft-a');

    s = govActionFormReducer(s, {
      kind: 'linkDraft',
      slug: 'draft-b',
      title: 'Draft B',
      siteOrigin: SITE_ORIGIN,
      selectedSlug: 'draft-a',
    });

    expect(s.linkedDraftSlug).toBe('draft-b');
    expect(s.metadata.references).toEqual([
      { label: 'Draft B', uri: `${SITE_ORIGIN}/t/draft-b/` },
      { label: 'Closed draft C', uri: `${SITE_ORIGIN}/t/closed-draft-c/` },
    ]);
  });

  it('replaces a hand-typed reference the control shows as chosen instead of adding a second one', () => {
    // Nothing was ever tracked: the reference was typed into the references
    // list by hand, and the select shows it as chosen all the same.
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { references: [{ label: 'Hand typed', uri: `${SITE_ORIGIN}/t/draft-a/` }] },
      siteOrigin: SITE_ORIGIN,
    });
    expect(effectiveLinkedDraftSlug(s, [{ slug: 'draft-a' }, { slug: 'draft-b' }], SITE_ORIGIN)).toBe('draft-a');

    s = govActionFormReducer(s, {
      kind: 'linkDraft',
      slug: 'draft-b',
      title: 'Draft B',
      siteOrigin: SITE_ORIGIN,
      selectedSlug: 'draft-a',
    });

    expect(s.linkedDraftSlug).toBe('draft-b');
    expect(s.metadata.references).toEqual([{ label: 'Draft B', uri: `${SITE_ORIGIN}/t/draft-b/` }]);
  });

  it('refuses to append at the cap and leaves the form untouched', () => {
    const fullRefs = Array.from({ length: REFERENCES_MAX }, (_, i) => ({ label: `R${i}`, uri: `https://example.org/${i}` }));
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { references: fullRefs },
    });
    const before = s;
    s = govActionFormReducer(s, { kind: 'linkDraft', slug: 'draft-a', title: 'Draft A', siteOrigin: SITE_ORIGIN });
    expect(s.linkedDraftSlug).toBeNull();
    expect(s.metadata.references).toEqual(before.metadata.references);
    expect(s.draftLinkError).toBe('Remove a reference first, the list is full');
  });
});

describe('unlinkDraft', () => {
  it('removes only the tracked reference and clears the slug', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { references: [{ label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` }] },
    });
    s = govActionFormReducer(s, { kind: 'linkDraft', slug: 'draft-a', title: 'Draft A', siteOrigin: SITE_ORIGIN });
    s = govActionFormReducer(s, { kind: 'unlinkDraft', siteOrigin: SITE_ORIGIN });
    expect(s.linkedDraftSlug).toBeNull();
    expect(s.metadata.references).toEqual([{ label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` }]);
  });

  it('removes a hand-typed reference the control shows as chosen', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: {
        references: [
          { label: 'Hand typed', uri: `${SITE_ORIGIN}/t/draft-a/` },
          { label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` },
        ],
      },
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBeNull();

    s = govActionFormReducer(s, { kind: 'unlinkDraft', siteOrigin: SITE_ORIGIN, selectedSlug: 'draft-a' });

    expect(s.linkedDraftSlug).toBeNull();
    expect(s.metadata.references).toEqual([{ label: 'Discussion', uri: `${SITE_ORIGIN}/t/other-thread/` }]);
  });

  it('is a no-op when nothing is tracked', () => {
    const s = govActionFormReducer(initialGovActionFormState(), { kind: 'unlinkDraft', siteOrigin: SITE_ORIGIN });
    expect(s.linkedDraftSlug).toBeNull();
    expect(s.metadata.references).toEqual([]);
  });
});

describe('setMetadata keeps the tracked slug in sync with the references', () => {
  it('clears the tracked slug once its reference is hand-edited to a different thread', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    // The URI input for that same row, edited by hand to a different draft's URL.
    s = govActionFormReducer(s, {
      kind: 'setMetadata',
      patch: { references: [{ label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-b/` }] },
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBeNull();
  });

  it('leaves the tracked slug alone when the edit does not touch its reference', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    s = govActionFormReducer(s, {
      kind: 'setMetadata',
      patch: { references: [...s.metadata.references, { label: 'Other', uri: 'https://example.org/x' }] },
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBe('draft-a');
  });

  it('leaves the tracked slug alone when the caller does not pass a siteOrigin', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    // No siteOrigin: there is no positive evidence the reference is gone, so
    // tracking is left exactly as it was rather than cleared on a guess.
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { references: [] } });
    expect(s.linkedDraftSlug).toBe('draft-a');
  });

  it('never clears the tracked slug for a patch that does not touch references at all', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    s = govActionFormReducer(s, { kind: 'setMetadata', patch: { title: 'A title' }, siteOrigin: SITE_ORIGIN });
    expect(s.linkedDraftSlug).toBe('draft-a');
  });
});

describe('effectiveLinkedDraftSlug', () => {
  it('returns the tracked slug when it still has a matching reference', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    expect(effectiveLinkedDraftSlug(s, [{ slug: 'draft-a' }], SITE_ORIGIN)).toBe('draft-a');
  });

  it('follows a hand-edited reference to a different open draft once tracking is cleared', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    s = govActionFormReducer(s, {
      kind: 'setMetadata',
      patch: { references: [{ label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-b/` }] },
      siteOrigin: SITE_ORIGIN,
    });
    expect(s.linkedDraftSlug).toBeNull();
    expect(effectiveLinkedDraftSlug(s, [{ slug: 'draft-b' }], SITE_ORIGIN)).toBe('draft-b');
  });

  it('picks up a hand-typed reference to an open draft even though nothing was ever tracked', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: { references: [{ label: 'Hand typed', uri: `${SITE_ORIGIN}/t/draft-b/` }] },
    });
    expect(effectiveLinkedDraftSlug(s, [{ slug: 'draft-b' }], SITE_ORIGIN)).toBe('draft-b');
  });

  it('is null when nothing is tracked and no reference names an open draft', () => {
    expect(effectiveLinkedDraftSlug(initialGovActionFormState(), [{ slug: 'draft-b' }], SITE_ORIGIN)).toBeNull();
  });
});

describe('linkedDraftReference', () => {
  it('finds the reference the tracked slug points at', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    expect(linkedDraftReference(s, SITE_ORIGIN)).toEqual({ label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` });
  });

  it('is null when nothing is tracked', () => {
    expect(linkedDraftReference(initialGovActionFormState(), SITE_ORIGIN)).toBeNull();
  });
});

describe('draftConflict', () => {
  it('is false with a single tracked draft reference', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'draft-a',
      title: 'Draft A',
      siteOrigin: SITE_ORIGIN,
    });
    expect(draftConflict(s, [{ slug: 'draft-a' }], SITE_ORIGIN)).toBe(false);
  });

  it('is true when two references name two different open drafts', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: {
        references: [
          { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
          { label: 'Draft B', uri: `${SITE_ORIGIN}/t/draft-b/` },
        ],
      },
    });
    expect(draftConflict(s, [{ slug: 'draft-a' }, { slug: 'draft-b' }], SITE_ORIGIN)).toBe(true);
  });

  it('is false when the second reference names a draft that is not open', () => {
    const s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'setMetadata',
      patch: {
        references: [
          { label: 'Draft A', uri: `${SITE_ORIGIN}/t/draft-a/` },
          { label: 'Not open', uri: `${SITE_ORIGIN}/t/not-open/` },
        ],
      },
    });
    expect(draftConflict(s, [{ slug: 'draft-a' }], SITE_ORIGIN)).toBe(false);
  });

  it('counts the tracked slug even once it falls off the open drafts list', () => {
    let s = govActionFormReducer(initialGovActionFormState(), {
      kind: 'linkDraft',
      slug: 'closed-draft',
      title: 'Closed draft',
      siteOrigin: SITE_ORIGIN,
    });
    s = govActionFormReducer(s, {
      kind: 'setMetadata',
      patch: { references: [...s.metadata.references, { label: 'Draft B', uri: `${SITE_ORIGIN}/t/draft-b/` }] },
    });
    // closed-draft is no longer in openDrafts, but it is still the tracked slug.
    expect(draftConflict(s, [{ slug: 'draft-b' }], SITE_ORIGIN)).toBe(true);
  });
});
