// Unit tests for the InfoAction ("/ga/new") localStorage draft helpers.
// Uses an in-memory fake storage (no jsdom / window needed) since the module
// takes storage as an injected Pick<Storage, ...>, mirroring how the vote
// draft flow in voteFlowClient.ts / VotePanel.tsx is tested.
import { describe, it, expect } from 'vitest';
import {
  infoActionDraftKey,
  loadInfoActionDraft,
  saveInfoActionDraft,
  clearInfoActionDraft,
  type InfoActionDraft,
} from './infoActionDraft.js';

/** A minimal in-memory Storage fake; optionally throws on a given method to simulate a blocked/full store. */
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

const fullDraft: InfoActionDraft = {
  title: 'My title',
  abstract: 'My abstract',
  motivation: 'My motivation',
  rationale: 'My rationale',
  signAsAuthor: true,
  authorName: 'Jane DRep',
  references: [{ label: 'Forum thread', uri: 'https://example.com/thread' }],
  surveyRef: '',
};

describe('saveInfoActionDraft / loadInfoActionDraft round trip', () => {
  it('round-trips every field, including references', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    saveInfoActionDraft(storage, key, fullDraft);
    expect(loadInfoActionDraft(storage, key)).toEqual(fullDraft);
  });

  it('round-trips an empty-references draft', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    const draft: InfoActionDraft = { ...fullDraft, references: [] };
    saveInfoActionDraft(storage, key, draft);
    expect(loadInfoActionDraft(storage, key)).toEqual(draft);
  });
});

describe('loadInfoActionDraft defensive parsing', () => {
  it.each([
    ['a missing key', null],
    ['invalid JSON', '{not valid json'],
    ['a wrong-shape value (a JSON array)', JSON.stringify([1, 2, 3])],
    ['a JSON primitive', JSON.stringify('just a string')],
  ])('returns null for %s', (_label, stored) => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    if (stored !== null) storage.setItem(key, stored);
    expect(loadInfoActionDraft(storage, key)).toBeNull();
  });

  it('coerces missing/wrong-typed fields to safe defaults instead of failing', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify({ title: 123, motivation: null, signAsAuthor: 'yes' }));
    expect(loadInfoActionDraft(storage, key)).toEqual({
      title: '',
      abstract: '',
      motivation: '',
      rationale: '',
      signAsAuthor: false,
      authorName: '',
      references: [],
      surveyRef: '',
    });
  });

  it('drops malformed reference rows and keeps well-formed ones', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
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
    expect(loadInfoActionDraft(storage, key)).toEqual({
      ...fullDraft,
      references: [{ label: 'Good row', uri: 'https://example.com' }],
    });
  });

  it('drops a non-array references field entirely', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify({ ...fullDraft, references: 'nope' }));
    expect(loadInfoActionDraft(storage, key)).toEqual({ ...fullDraft, references: [] });
  });
});

describe('clearInfoActionDraft', () => {
  it('removes a stored draft', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    saveInfoActionDraft(storage, key, fullDraft);
    clearInfoActionDraft(storage, key);
    expect(loadInfoActionDraft(storage, key)).toBeNull();
  });
});

describe('storage failures (quota, blocked storage)', () => {
  type Store = ReturnType<typeof makeFakeStorage>;
  // Calling without a throw is the assertion. A failed read reports no draft.
  it.each([
    ['getItem', (st: Store, key: string) => loadInfoActionDraft(st, key), null],
    ['setItem', (st: Store, key: string) => saveInfoActionDraft(st, key, fullDraft), undefined],
    ['removeItem', (st: Store, key: string) => clearInfoActionDraft(st, key), undefined],
  ] as const)('never throws when storage.%s throws', (method, call, expected) => {
    const storage = makeFakeStorage({ throwOn: method });
    expect(call(storage, infoActionDraftKey('preprod'))).toBe(expected);
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
    const draft: InfoActionDraft = {
      title: 't', abstract: 'a', motivation: 'm', rationale: 'r',
      signAsAuthor: false, authorName: '', references: [],
      surveyRef: 'ab'.repeat(32) + ':3',
    };
    saveInfoActionDraft(storage, 'k', draft);
    expect(loadInfoActionDraft(storage, 'k')?.surveyRef).toBe(draft.surveyRef);
  });

  it('loads a draft written before the field existed as having no link', () => {
    const store = new Map<string, string>([
      ['k', JSON.stringify({ title: 't', abstract: 'a', motivation: 'm', rationale: 'r', signAsAuthor: false, authorName: '', references: [] })],
    ]);
    const storage = { getItem: (k: string) => store.get(k) ?? null };
    expect(loadInfoActionDraft(storage, 'k')?.surveyRef).toBe('');
  });
});
