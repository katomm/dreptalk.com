// Unit tests for the governance action submit form ("/ga/new") localStorage
// draft helpers, v2 format (type plus per-type panel state layered on top of
// the CIP-108 metadata fields). Uses an in-memory fake storage (no jsdom /
// window needed) since the module takes storage as an injected
// Pick<Storage, ...>, mirroring how the vote draft flow in
// voteFlowClient.ts / VotePanel.tsx is tested.
import { describe, it, expect } from 'vitest';
import {
  govActionDraftKey,
  loadGovActionDraft,
  saveGovActionDraft,
  clearGovActionDraft,
  type GovActionDraft,
} from './govActionDraft.js';

/** A minimal in-memory Storage fake, optionally throws on a given method to simulate a blocked/full store. */
function makeFakeStorage(opts?: { throwOn?: 'getItem' | 'setItem' | 'removeItem' }) {
  const map = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      if (opts?.throwOn === 'getItem') throw new Error('blocked');
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      if (opts?.throwOn === 'setItem') throw new Error('quota exceeded');
      map.set(key, value);
    },
    removeItem(key: string): void {
      if (opts?.throwOn === 'removeItem') throw new Error('blocked');
      map.delete(key);
    },
    _map: map,
  };
}

const fullDraft: GovActionDraft = {
  v: 2,
  type: 'InfoAction',
  title: 'My title',
  abstract: 'My abstract',
  motivation: 'My motivation',
  rationale: 'My rationale',
  signAsAuthor: true,
  authorName: 'Jane DRep',
  references: [{ label: 'Forum thread', uri: 'https://example.com/thread' }],
  surveyRef: '',
  panels: {},
};

describe('govActionDraftKey', () => {
  it('scopes the key by network, same string as the v1 InfoAction-only key', () => {
    expect(govActionDraftKey('preprod')).toBe('dreptalk:ga-new-draft:preprod');
    expect(govActionDraftKey('mainnet')).toBe('dreptalk:ga-new-draft:mainnet');
  });
});

// A fixed save time, so the round-trip tests can assert an exact savedAt
// instead of merely "some number close to now".
const SAVED_AT = 1_700_000_000_000;

describe('saveGovActionDraft / loadGovActionDraft round trip', () => {
  it('round-trips every metadata field, including references', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    saveGovActionDraft(storage, key, fullDraft, SAVED_AT);
    expect(loadGovActionDraft(storage, key)).toEqual({ ...fullDraft, savedAt: SAVED_AT });
  });

  it('round-trips an empty-references draft', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    const draft: GovActionDraft = { ...fullDraft, references: [] };
    saveGovActionDraft(storage, key, draft, SAVED_AT);
    expect(loadGovActionDraft(storage, key)).toEqual({ ...draft, savedAt: SAVED_AT });
  });

  it('round-trips a v2 draft with type UpdateCommittee and its panel state', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    const draft: GovActionDraft = {
      ...fullDraft,
      type: 'UpdateCommittee',
      panels: { UpdateCommittee: { addMembers: ['abc'], threshold: '2/3' } },
    };
    saveGovActionDraft(storage, key, draft, SAVED_AT);
    expect(loadGovActionDraft(storage, key)).toEqual({ ...draft, savedAt: SAVED_AT });
  });
});

describe('savedAt', () => {
  it('is written on every save, and defaults to Date.now() when not passed explicitly', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    const before = Date.now();
    saveGovActionDraft(storage, key, fullDraft);
    const after = Date.now();
    const loaded = loadGovActionDraft(storage, key);
    expect(loaded?.savedAt).toBeGreaterThanOrEqual(before);
    expect(loaded?.savedAt).toBeLessThanOrEqual(after);
  });

  it('is tolerated when absent from an older stored draft', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify(fullDraft));
    expect(loadGovActionDraft(storage, key)?.savedAt).toBeUndefined();
  });
});

describe('loadGovActionDraft v1 upgrade', () => {
  it('loads a stored v1 draft (no v field, current InfoActionDraft shape) as v2 InfoAction with empty panels', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(
      key,
      JSON.stringify({
        title: 'Old title',
        abstract: 'Old abstract',
        motivation: 'Old motivation',
        rationale: 'Old rationale',
        signAsAuthor: false,
        authorName: 'Old author',
        references: [{ label: 'r', uri: 'https://example.com' }],
        surveyRef: '',
      }),
    );
    expect(loadGovActionDraft(storage, key)).toEqual({
      v: 2,
      type: 'InfoAction',
      title: 'Old title',
      abstract: 'Old abstract',
      motivation: 'Old motivation',
      rationale: 'Old rationale',
      signAsAuthor: false,
      authorName: 'Old author',
      references: [{ label: 'r', uri: 'https://example.com' }],
      surveyRef: '',
      panels: {},
    });
  });
});

describe('loadGovActionDraft defensive parsing', () => {
  it('returns null for a missing key', () => {
    const storage = makeFakeStorage();
    expect(loadGovActionDraft(storage, govActionDraftKey('preprod'))).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, '{not valid json');
    expect(loadGovActionDraft(storage, key)).toBeNull();
  });

  it('returns null for a wrong-shape value (e.g. a JSON array)', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify([1, 2, 3]));
    expect(loadGovActionDraft(storage, key)).toBeNull();
  });

  it('returns null for a JSON primitive', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify('just a string'));
    expect(loadGovActionDraft(storage, key)).toBeNull();
  });

  it('coerces missing/wrong-typed fields to safe defaults instead of failing', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify({ title: 123, motivation: null, signAsAuthor: 'yes' }));
    expect(loadGovActionDraft(storage, key)).toEqual({
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
    });
  });

  it('falls back to InfoAction for an unknown type string', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify({ ...fullDraft, type: 'SomethingMadeUp' }));
    expect(loadGovActionDraft(storage, key)?.type).toBe('InfoAction');
  });

  it('drops malformed reference rows and keeps well-formed ones', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(
      key,
      JSON.stringify({
        ...fullDraft,
        references: [
          { label: 'Good row', uri: 'https://example.com' },
          { label: 'Missing uri' },
          { uri: 'https://example.com/missing-label' },
          'not an object',
          null,
          { label: 42, uri: 'https://example.com/bad-label-type' },
          { label: 'Bad uri type', uri: 7 },
        ],
      }),
    );
    expect(loadGovActionDraft(storage, key)).toEqual({
      ...fullDraft,
      references: [{ label: 'Good row', uri: 'https://example.com' }],
    });
  });

  it('drops a non-array references field entirely', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify({ ...fullDraft, references: 'nope' }));
    expect(loadGovActionDraft(storage, key)).toEqual({ ...fullDraft, references: [] });
  });

  it('drops malformed panel state for one type while the rest of the draft survives', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(
      key,
      JSON.stringify({
        ...fullDraft,
        type: 'UpdateCommittee',
        panels: {
          UpdateCommittee: 'not an object',
          NewConstitution: ['also not an object'],
          HardForkInitiation: { protocolVersion: '11' },
        },
      }),
    );
    expect(loadGovActionDraft(storage, key)).toEqual({
      ...fullDraft,
      type: 'UpdateCommittee',
      panels: { HardForkInitiation: { protocolVersion: '11' } },
    });
  });

  it('drops a non-object panels field entirely', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify({ ...fullDraft, panels: 'nope' }));
    expect(loadGovActionDraft(storage, key)).toEqual({ ...fullDraft, panels: {} });
  });

  it('never throws when storage.getItem throws', () => {
    const storage = makeFakeStorage({ throwOn: 'getItem' });
    expect(() => loadGovActionDraft(storage, govActionDraftKey('preprod'))).not.toThrow();
    expect(loadGovActionDraft(storage, govActionDraftKey('preprod'))).toBeNull();
  });
});

describe('clearGovActionDraft', () => {
  it('removes a stored draft', () => {
    const storage = makeFakeStorage();
    const key = govActionDraftKey('preprod');
    saveGovActionDraft(storage, key, fullDraft);
    clearGovActionDraft(storage, key);
    expect(loadGovActionDraft(storage, key)).toBeNull();
  });

  it('never throws when storage.removeItem throws', () => {
    const storage = makeFakeStorage({ throwOn: 'removeItem' });
    expect(() => clearGovActionDraft(storage, govActionDraftKey('preprod'))).not.toThrow();
  });
});

describe('saveGovActionDraft resilience', () => {
  it('never throws when storage.setItem throws (quota / blocked storage)', () => {
    const storage = makeFakeStorage({ throwOn: 'setItem' });
    expect(() => saveGovActionDraft(storage, govActionDraftKey('preprod'), fullDraft)).not.toThrow();
  });
});

describe('the survey link is part of the draft', () => {
  it('round-trips a survey reference', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const draft: GovActionDraft = {
      ...fullDraft,
      surveyRef: `${'ab'.repeat(32)}:3`,
    };
    saveGovActionDraft(storage, 'k', draft);
    expect(loadGovActionDraft(storage, 'k')?.surveyRef).toBe(draft.surveyRef);
  });

  it('loads a v1 draft written before the field existed as having no link', () => {
    const store = new Map<string, string>([
      ['k', JSON.stringify({ title: 't', abstract: 'a', motivation: 'm', rationale: 'r', signAsAuthor: false, authorName: '', references: [] })],
    ]);
    const storage = { getItem: (k: string) => store.get(k) ?? null };
    expect(loadGovActionDraft(storage, 'k')?.surveyRef).toBe('');
  });
});

describe('linkedDraftSlug is part of the draft', () => {
  it('round-trips a linked slug', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const draft: GovActionDraft = { ...fullDraft, linkedDraftSlug: 'my-draft-a1b2' };
    saveGovActionDraft(storage, 'k', draft);
    expect(loadGovActionDraft(storage, 'k')?.linkedDraftSlug).toBe('my-draft-a1b2');
  });

  it('round-trips an explicit null (linked then unlinked, still on the v2+ format)', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const draft: GovActionDraft = { ...fullDraft, linkedDraftSlug: null };
    saveGovActionDraft(storage, 'k', draft);
    expect(loadGovActionDraft(storage, 'k')?.linkedDraftSlug).toBeNull();
  });

  it('leaves the field undefined for a draft saved before it existed', () => {
    const store = new Map<string, string>([['k', JSON.stringify(fullDraft)]]);
    const storage = { getItem: (k: string) => store.get(k) ?? null };
    expect(loadGovActionDraft(storage, 'k')?.linkedDraftSlug).toBeUndefined();
  });
});
