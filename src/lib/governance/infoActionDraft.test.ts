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
};

describe('infoActionDraftKey', () => {
  it('scopes the key by network', () => {
    expect(infoActionDraftKey('preprod')).toBe('dreptalk:ga-new-draft:preprod');
    expect(infoActionDraftKey('mainnet')).toBe('dreptalk:ga-new-draft:mainnet');
  });
});

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
  it('returns null for a missing key', () => {
    const storage = makeFakeStorage();
    expect(loadInfoActionDraft(storage, infoActionDraftKey('preprod'))).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    storage.setItem(key, '{not valid json');
    expect(loadInfoActionDraft(storage, key)).toBeNull();
  });

  it('returns null for a wrong-shape value (e.g. a JSON array)', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify([1, 2, 3]));
    expect(loadInfoActionDraft(storage, key)).toBeNull();
  });

  it('returns null for a JSON primitive', () => {
    const storage = makeFakeStorage();
    const key = infoActionDraftKey('preprod');
    storage.setItem(key, JSON.stringify('just a string'));
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

  it('never throws when storage.getItem throws', () => {
    const storage = makeFakeStorage({ throwOn: 'getItem' });
    expect(() => loadInfoActionDraft(storage, infoActionDraftKey('preprod'))).not.toThrow();
    expect(loadInfoActionDraft(storage, infoActionDraftKey('preprod'))).toBeNull();
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

  it('never throws when storage.removeItem throws', () => {
    const storage = makeFakeStorage({ throwOn: 'removeItem' });
    expect(() => clearInfoActionDraft(storage, infoActionDraftKey('preprod'))).not.toThrow();
  });
});

describe('saveInfoActionDraft resilience', () => {
  it('never throws when storage.setItem throws (quota / blocked storage)', () => {
    const storage = makeFakeStorage({ throwOn: 'setItem' });
    expect(() => saveInfoActionDraft(storage, infoActionDraftKey('preprod'), fullDraft)).not.toThrow();
  });
});
