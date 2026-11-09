import { describe, expect, it } from 'vitest';
import { historyEntries, type HistoryInput } from './history.js';
import type { ScriptView } from './view.js';

const K = (n: number): string => n.toString(16).padStart(56, '0');
const T = (n: number): string => n.toString(16).padStart(64, '0');
const [A, B, C, PAY] = [K(1), K(2), K(3), K(9)];
const key = (hash: string) => ({ kind: 'key' as const, hash });
const nOfK = (n: number, keys: string[]): ScriptView => ({ kind: 'nOfK', n: String(n), children: keys.map((k) => ({ kind: 'sig', keyHash: k })) });
const [P1, P2] = ['p1'.padEnd(56, '0'), 'p2'.padEnd(56, '0')];
const [DOC1, DOC2] = ['d1'.padEnd(64, '0'), 'd2'.padEnd(64, '0')];

const ctx = {
  mode: 'permissioned' as const,
  scripts: new Map([
    [P1, nOfK(2, [A, B])],
    [P2, nOfK(2, [A, B, C])],
  ]),
  profiles: new Map([
    [DOC1, { name: 'Old', image: 'https://x.example/1.png' }],
    [DOC2, { name: 'New', image: 'https://x.example/2.png' }],
  ]),
  policyKeys: new Set([A, B, C]),
  names: new Map([
    [A, 'Alice'],
    [B, 'Bob'],
    [C, 'Carol'],
  ]),
};

describe('historyEntries', () => {
  it('reads one entry per transaction, newest first, with policy and profile changes', () => {
    const input: HistoryInput = {
      // Newest first, as the verdicts are read.
      events: [
        { txHash: T(4), eventIndex: 0, tag: 'update', subject: null, blockHeight: 40 },
        { txHash: T(3), eventIndex: 1, tag: 'update', subject: null, blockHeight: 30 },
        { txHash: T(3), eventIndex: 0, tag: 'approve', subject: key(C), blockHeight: 30 },
        { txHash: T(2), eventIndex: 0, tag: 'join', subject: key(C), blockHeight: 20 },
        { txHash: T(1), eventIndex: 4, tag: 'approve', subject: key(B), blockHeight: 10 },
        { txHash: T(1), eventIndex: 3, tag: 'approve', subject: key(A), blockHeight: 10 },
        { txHash: T(1), eventIndex: 2, tag: 'join', subject: key(B), blockHeight: 10 },
        { txHash: T(1), eventIndex: 1, tag: 'join', subject: key(A), blockHeight: 10 },
        { txHash: T(1), eventIndex: 0, tag: 'create', subject: null, blockHeight: 10 },
      ],
      versions: [
        { txHash: T(1), control: P1, admission: P1, profileHash: DOC1 },
        { txHash: T(3), control: P2, admission: P2, profileHash: DOC1 },
        { txHash: T(4), control: P2, admission: P2, profileHash: DOC2 },
      ],
      signers: new Map([
        [T(3), [A, PAY, B]],
        [T(4), [B, PAY]],
      ]),
    };
    expect(historyEntries(input, ctx)).toEqual([
      { txHash: T(4), blockHeight: 40, kind: 'profile', text: 'Profile updated: name, image. Signed by Bob.' },
      {
        txHash: T(3),
        blockHeight: 30,
        kind: 'approved',
        text: 'Carol joined, approved by Alice and Bob. Management and admission policy changed from 2 of 2 to 2 of 3. Added: Carol.',
      },
      { txHash: T(2), blockHeight: 20, kind: 'requested', text: 'Carol requested to join.' },
      { txHash: T(1), blockHeight: 10, kind: 'founded', text: 'Group founded by Alice and Bob, managed by 2 of 2: Alice and Bob.' },
    ]);
  });

  it('says only that the profile was updated without the earlier document', () => {
    const input: HistoryInput = {
      events: [{ txHash: T(5), eventIndex: 0, tag: 'update', subject: null, blockHeight: 50 }],
      versions: [
        { txHash: T(1), control: P1, admission: P1, profileHash: 'ee'.repeat(32) },
        { txHash: T(5), control: P1, admission: P1, profileHash: DOC2 },
      ],
      signers: new Map(),
    };
    expect(historyEntries(input, ctx)).toEqual([{ txHash: T(5), blockHeight: 50, kind: 'profile', text: 'Profile updated.' }]);
  });

  it('reads a leave, a removal and a dissolution', () => {
    const input: HistoryInput = {
      events: [
        { txHash: T(8), eventIndex: 0, tag: 'dissolve', subject: null, blockHeight: 80 },
        { txHash: T(7), eventIndex: 0, tag: 'remove', subject: key(C), blockHeight: 70 },
        { txHash: T(6), eventIndex: 0, tag: 'leave', subject: key(B), blockHeight: 60 },
      ],
      versions: [
        { txHash: T(1), control: P1, admission: P1, profileHash: DOC1 },
        { txHash: T(8), control: P1, admission: P1, profileHash: DOC1 },
      ],
      signers: new Map([
        [T(8), [A, B]],
        [T(7), [A]],
      ]),
    };
    expect(historyEntries(input, ctx).map((e) => [e.kind, e.text])).toEqual([
      ['dissolved', 'Group dissolved by Alice and Bob.'],
      ['removed', 'Carol removed by Alice.'],
      ['left', 'Bob left.'],
    ]);
  });
});
