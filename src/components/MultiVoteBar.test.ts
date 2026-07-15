// Node-env unit tests for MultiVoteBar's pure logic: selection toggling,
// effective-rationale resolution, and the dependency-injected batch submit
// orchestration (mirrors VotePanel.test.ts's approach to submitVote).
import { describe, it, expect, vi } from 'vitest';
import {
  effectiveRationale,
  toggleSelection,
  submitMultiVote,
  countUniqueRationales,
  MAX_UNIQUE_BATCH_RATIONALES,
  PreSignError,
  type SubmitMultiVoteDeps,
} from './MultiVoteBar';

describe('toggleSelection', () => {
  it('adds, changes, and toggles off a choice', () => {
    let sel: Record<string, 'yes' | 'no' | 'abstain'> = {};
    sel = toggleSelection(sel, 'ga1', 'yes');
    expect(sel).toEqual({ ga1: 'yes' });
    sel = toggleSelection(sel, 'ga1', 'no');
    expect(sel).toEqual({ ga1: 'no' });
    sel = toggleSelection(sel, 'ga1', 'no'); // same choice again = deselect
    expect(sel).toEqual({});
  });
});

describe('effectiveRationale', () => {
  it('prefers the per-action override, falls back to shared, else empty', () => {
    expect(effectiveRationale('shared text', 'override')).toBe('override');
    expect(effectiveRationale('shared text', '   ')).toBe('shared text');
    expect(effectiveRationale('', '')).toBe('');
    expect(effectiveRationale('  ', '')).toBe('');
  });
});

describe('countUniqueRationales', () => {
  it('counts distinct effective texts: shared once, overrides individually, empties ignored', () => {
    const gaIds = ['ga1', 'ga2', 'ga3', 'ga4'];
    expect(countUniqueRationales(gaIds, '', {})).toBe(0);
    // Shared text applies to every action but counts once.
    expect(countUniqueRationales(gaIds, 'shared', {})).toBe(1);
    // One override on top of shared: two distinct texts.
    expect(countUniqueRationales(gaIds, 'shared', { ga2: 'special' })).toBe(2);
    // Two overrides with the SAME text dedupe.
    expect(countUniqueRationales(gaIds, 'shared', { ga2: 'special', ga3: 'special' })).toBe(2);
    // No shared text: only non-empty overrides count.
    expect(countUniqueRationales(gaIds, '', { ga1: 'a', ga2: 'b', ga3: '   ' })).toBe(2);
  });
});

function makeArgs(overrides: Partial<Parameters<typeof submitMultiVote>[1]> = {}) {
  return {
    selections: [
      { gaId: `${'a'.repeat(64)}#0`, choice: 'yes' as const },
      { gaId: `${'b'.repeat(64)}#1`, choice: 'no' as const },
    ],
    sharedRationale: '',
    overrides: {},
    crossPost: false,
    drepId: `drep1${'x'.repeat(50)}`,
    drepKeyHash: new Uint8Array(28).fill(7),
    network: 'preprod' as const,
    origin: 'https://dreptalk.com',
    // biome-ignore lint/suspicious/noExplicitAny: pass-through to mocked castVotes
    walletApi: {} as any,
    ...overrides,
  };
}

function makeDeps() {
  // Explicit vi.fn generics so mock.calls carries the real parameter type
  // (an implementation with no declared params would otherwise infer an
  // empty-tuple call signature and break the `.mock.calls[0][0]` reads below).
  const hostRationale = vi.fn<SubmitMultiVoteDeps['hostRationale']>(async ({ rationale }) => ({
    url: `https://dreptalk.com/vote-rationale/${rationale.length}.json`,
    hash: 'f'.repeat(64),
  }));
  const castVotes = vi.fn<SubmitMultiVoteDeps['castVotes']>(async () => ({ txHash: 'd'.repeat(64) }));
  const recordVotes = vi.fn<SubmitMultiVoteDeps['recordVotes']>(async () => {});
  const deps: SubmitMultiVoteDeps = { hostRationale, castVotes, recordVotes };
  return { deps, hostRationale, castVotes, recordVotes };
}

describe('submitMultiVote', () => {
  it('no rationale: hosts nothing, casts all votes without anchors, records with txHash', async () => {
    const { deps, hostRationale, castVotes, recordVotes } = makeDeps();
    const args = makeArgs();
    const res = await submitMultiVote(deps, args);
    expect(res.txHash).toBe('d'.repeat(64));
    expect(hostRationale).not.toHaveBeenCalled();
    const casted = castVotes.mock.calls[0][0];
    expect(casted.votes).toHaveLength(2);
    expect(casted.votes.every((v: { anchorUrl?: string }) => v.anchorUrl === undefined)).toBe(true);
    const recorded = recordVotes.mock.calls[0][0];
    expect(recorded.txHash).toBe('d'.repeat(64));
    expect(recorded.votes).toHaveLength(2);
  });

  it('shared rationale: hosts ONCE and reuses the anchor on every vote', async () => {
    const { deps, hostRationale, castVotes } = makeDeps();
    const args = makeArgs({ sharedRationale: 'same reasoning for both' });
    await submitMultiVote(deps, args);
    expect(hostRationale).toHaveBeenCalledTimes(1);
    const casted = castVotes.mock.calls[0][0];
    const urls = casted.votes.map((v: { anchorUrl?: string }) => v.anchorUrl);
    expect(urls[0]).toBeDefined();
    expect(urls[0]).toBe(urls[1]);
  });

  it('override rationale: hosts per unique text and maps anchors to the right actions', async () => {
    const { deps, hostRationale, castVotes, recordVotes } = makeDeps();
    const gaA = `${'a'.repeat(64)}#0`;
    const gaB = `${'b'.repeat(64)}#1`;
    const args = makeArgs({
      sharedRationale: 'shared reasoning',
      overrides: { [gaB]: 'special case for B' },
      crossPost: true,
    });
    await submitMultiVote(deps, args);
    expect(hostRationale).toHaveBeenCalledTimes(2);
    const casted = castVotes.mock.calls[0][0];
    const byId = Object.fromEntries(casted.votes.map((v: { govActionId: string; anchorUrl?: string }) => [v.govActionId, v.anchorUrl]));
    expect(byId[gaA]).not.toBe(byId[gaB]);
    // recordVotes carries the effective text + crossPost per vote.
    const recorded = recordVotes.mock.calls[0][0];
    const recA = recorded.votes.find((v: { gaId: string }) => v.gaId === gaA)!;
    const recB = recorded.votes.find((v: { gaId: string }) => v.gaId === gaB)!;
    expect(recA.rationaleText).toBe('shared reasoning');
    expect(recB.rationaleText).toBe('special case for B');
    expect(recA.crossPost).toBe(true);
  });

  it('rejects an empty selection', async () => {
    const { deps } = makeDeps();
    await expect(submitMultiVote(deps, makeArgs({ selections: [] }))).rejects.toThrow();
  });

  it('rejects a batch exceeding the distinct-rationale cap before hosting anything', async () => {
    const { deps, hostRationale } = makeDeps();
    const n = MAX_UNIQUE_BATCH_RATIONALES + 1;
    const selections = Array.from({ length: n }, (_, i) => ({
      gaId: `${String(i).padStart(2, '0').repeat(32)}#0`,
      choice: 'yes' as const,
    }));
    const overrides = Object.fromEntries(selections.map((s, i) => [s.gaId, `distinct rationale ${i}`]));
    const rejection = await submitMultiVote(deps, makeArgs({ selections, overrides })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(PreSignError);
    expect(String(rejection)).toMatch(/rationale texts/);
    // The guard must fire before the first hosting request (a mid-loop 429
    // would abort the submit after some documents were already hosted).
    expect(hostRationale).not.toHaveBeenCalled();
  });

  it('accepts a batch at exactly the distinct-rationale cap', async () => {
    const { deps, hostRationale } = makeDeps();
    const selections = Array.from({ length: MAX_UNIQUE_BATCH_RATIONALES }, (_, i) => ({
      gaId: `${String(i).padStart(2, '0').repeat(32)}#0`,
      choice: 'no' as const,
    }));
    const overrides = Object.fromEntries(selections.map((s, i) => [s.gaId, `distinct rationale ${i}`]));
    const res = await submitMultiVote(deps, makeArgs({ selections, overrides }));
    expect(res.txHash).toBe('d'.repeat(64));
    expect(hostRationale).toHaveBeenCalledTimes(MAX_UNIQUE_BATCH_RATIONALES);
  });

  it('still resolves with the txHash when recordVotes rejects (votes are already on chain)', async () => {
    const { deps, recordVotes } = makeDeps();
    recordVotes.mockRejectedValueOnce(new Error('record timeout'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await submitMultiVote(deps, makeArgs());
      expect(res.txHash).toBe('d'.repeat(64));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
