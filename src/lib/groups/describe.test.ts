import { describe, expect, it } from 'vitest';
import {
  changedProfileFields,
  describeAction,
  describeHistory,
  describePolicyChange,
  describeProfileChange,
  drepLabel,
  noChanges,
  policyKeyParts,
  policyShape,
  profileFieldsOfDoc,
  wordList,
} from './describe.js';
import { drepIdForCredential } from './ids.js';
import { type ScriptView, shortHash } from './view.js';

const K = (n: number): string => n.toString(16).padStart(56, '0');
const [A, B, C, D] = [K(1), K(2), K(3), K(4)];
const names = new Map([
  [A, 'Alice'],
  [B, 'Bob'],
  [C, 'Carol'],
]);
const sig = (keyHash: string): ScriptView => ({ kind: 'sig', keyHash });
const nOfK = (n: number, keys: string[]): ScriptView => ({ kind: 'nOfK', n: String(n), children: keys.map(sig) });
const key = (hash: string) => ({ kind: 'key' as const, hash });

describe('names and lists', () => {
  it('names a DRep by its name, else by its short DRep id', () => {
    expect(drepLabel(key(A), names)).toBe('Alice');
    expect(drepLabel(key(D), names)).toBe(shortHash(drepIdForCredential(key(D))));
  });

  it('joins words with commas and a final and', () => {
    expect(wordList([])).toBe('');
    expect(wordList(['A'])).toBe('A');
    expect(wordList(['A', 'B'])).toBe('A and B');
    expect(wordList(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('policyShape', () => {
  it('reads flat policies over keys', () => {
    expect(policyShape(nOfK(2, [A, B, C]))).toEqual({ n: 2, keys: [A, B, C] });
    expect(policyShape({ kind: 'all', children: [sig(A), sig(B)] })).toEqual({ n: 2, keys: [A, B] });
    expect(policyShape({ kind: 'any', children: [sig(A), sig(B)] })).toEqual({ n: 1, keys: [A, B] });
    expect(policyShape(sig(A))).toEqual({ n: 1, keys: [A] });
  });

  it('gives nothing for nested or time locked policies', () => {
    expect(policyShape({ kind: 'all', children: [sig(A), { kind: 'after', slot: '5' }] })).toBeNull();
    expect(policyShape(null)).toBeNull();
  });
});

describe('describePolicyChange', () => {
  it('says the threshold before and after and the keys removed and added', () => {
    expect(describePolicyChange('control', nOfK(3, [A, B, C, D]), nOfK(2, [A, B, C]), names)).toBe(
      `Management policy changed from 3 of 4 to 2 of 3. Removed: ${drepLabel(key(D), names)}.`,
    );
    expect(describePolicyChange('both', nOfK(2, [A, B]), nOfK(3, [A, B, C]), names)).toBe(
      'Management and admission policy changed from 2 of 2 to 3 of 3. Added: Carol.',
    );
  });

  it('keeps the ratio when only keys are swapped', () => {
    expect(describePolicyChange('admission', nOfK(1, [A, B]), nOfK(1, [A, C]), names)).toBe(
      'Admission policy stays 1 of 2. Removed: Bob. Added: Carol.',
    );
  });

  it('words a change still to be signed as one that will happen', () => {
    expect(describePolicyChange('control', nOfK(3, [A, B, C, D]), nOfK(2, [A, B, C]), names, { pending: true })).toMatch(/^Management policy changes from 3 of 4 to 2 of 3\./);
    expect(describeProfileChange({ name: 'A' }, { name: 'B' }, { values: true, pending: true })).toBe('Profile changes: name to "B".');
  });

  it('sets a policy without an earlier one and describes a nested one in full', () => {
    expect(describePolicyChange('control', null, nOfK(2, [A, B, C]), names)).toBe('Management policy set to 2 of 3: Alice, Bob and Carol.');
    const nested: ScriptView = { kind: 'all', children: [sig(A), { kind: 'after', slot: '9' }] };
    expect(describePolicyChange('control', nOfK(1, [A]), nested, names)).toBe(
      'Management policy changed to all of: Alice, valid from slot 9.',
    );
  });
});

describe('describeProfileChange', () => {
  const before = { name: 'Old', description: 'Same', website: 'https://a.example', image: 'https://a.example/i.png' };

  it('names the changed fields', () => {
    const after = { ...before, name: 'New', image: 'https://a.example/j.png' };
    expect(changedProfileFields(before, after)).toEqual(['name', 'image']);
    expect(describeProfileChange(before, after)).toBe('Profile updated: name, image.');
  });

  it('gives the new value of short text fields and a removed field', () => {
    const after = { ...before, name: 'New', website: '', description: 'Other' };
    expect(describeProfileChange(before, after, { values: true })).toBe('Profile updated: name to "New", description, website removed.');
  });

  it('only says that the profile was updated without both documents', () => {
    expect(describeProfileChange(null, { name: 'New' })).toBe('Profile updated.');
    expect(describeProfileChange(null, { name: 'New' }, { values: true })).toBe('Profile updated, named "New".');
    expect(describeProfileChange(before, before)).toBe('Profile unchanged.');
  });

  it('reads the fields of a profile document', () => {
    const doc = JSON.stringify({ body: { name: 'G', description: { '@value': 'D' }, image: 'https://x.example/i.png' } });
    expect(profileFieldsOfDoc(doc)).toEqual({ name: 'G', description: 'D', website: null, charter: null, image: 'https://x.example/i.png' });
    expect(profileFieldsOfDoc('not json')).toBeNull();
    expect(profileFieldsOfDoc(null)).toBeNull();
  });
});

describe('describeAction', () => {
  it('names approved and removed members by DRep, never by the join reference', () => {
    const c = { ...noChanges('permissioned'), approvals: [key(C)], removals: [key(D)] };
    expect(describeAction(c, names)).toEqual(['Approve Carol as a member.', `Remove ${drepLabel(key(D), names)} from the group.`]);
  });

  it('words a combined approval with the policy update', () => {
    const c = { ...noChanges('permissioned'), approvals: [key(C)], control: { before: nOfK(2, [A, B]), after: nOfK(2, [A, B, C]) }, admission: 'same' as const };
    expect(describeAction(c, names)).toEqual([
      'Approve Carol as a member.',
      'Management and admission policy changes from 2 of 2 to 2 of 3. Added: Carol.',
    ]);
  });

  it('folds a founding into one line with its founders', () => {
    const c = {
      ...noChanges('permissioned'),
      create: { control: nOfK(2, [A, B, C]), admission: 'same' as const },
      joins: [key(A), key(B), key(C)],
      approvals: [key(A), key(B), key(C)],
    };
    expect(describeAction(c, names)).toEqual(['Found a permissioned group with Alice, Bob and Carol as founders, managed by 2 of 3: Alice, Bob and Carol.']);
  });

  it('words joins, leaves, profile changes and a dissolution', () => {
    expect(describeAction({ ...noChanges('open'), joins: [key(A)] }, names)).toEqual(['Alice joins the group.']);
    expect(describeAction({ ...noChanges('permissioned'), joins: [key(A)] }, names)).toEqual(['Alice requests to join the group.']);
    expect(describeAction({ ...noChanges('open'), leaves: [key(B)] }, names)).toEqual(['Bob leaves the group.']);
    expect(describeAction({ ...noChanges(), profile: { before: { name: 'A' }, after: { name: 'B' } } }, names)).toEqual([
      'Profile changes: name to "B".',
    ]);
    expect(describeAction({ ...noChanges(), dissolve: true }, names)).toEqual(['Dissolve the group. Every membership ends.']);
    expect(describeAction({ ...noChanges(), approvals: [null] }, names)).toEqual(['Approve a request that is no longer stored as a member.']);
  });
});

describe('describeHistory', () => {
  it('reads a founding as one entry', () => {
    const c = { ...noChanges('permissioned'), create: { control: nOfK(2, [A, B, C]), admission: 'same' as const }, joins: [key(A), key(B), key(C)], approvals: [key(A), key(B), key(C)] };
    expect(describeHistory(c, [A, B, C], names)).toEqual({ kind: 'founded', text: 'Group founded by Alice, Bob and Carol, managed by 2 of 3: Alice, Bob and Carol.' });
  });

  it('reads an approval with its signers and the policy update of the same transaction', () => {
    const c = { ...noChanges('permissioned'), approvals: [key(C)], control: { before: nOfK(2, [A, B]), after: nOfK(2, [A, B, C]) }, admission: 'same' as const };
    expect(describeHistory(c, [A, B], names)).toEqual({
      kind: 'approved',
      text: 'Carol joined, approved by Alice and Bob. Management and admission policy changed from 2 of 2 to 2 of 3. Added: Carol.',
    });
  });

  it('reads requests, joins, leaves, removals, updates and a dissolution', () => {
    expect(describeHistory({ ...noChanges('permissioned'), joins: [key(C)] }, [], names)).toEqual({ kind: 'requested', text: 'Carol requested to join.' });
    expect(describeHistory({ ...noChanges('open'), joins: [key(C)] }, [], names)).toEqual({ kind: 'joined', text: 'Carol joined.' });
    expect(describeHistory({ ...noChanges('open'), leaves: [key(C)] }, [], names)).toEqual({ kind: 'left', text: 'Carol left.' });
    expect(describeHistory({ ...noChanges('permissioned'), removals: [key(C)] }, [A], names)).toEqual({ kind: 'removed', text: 'Carol removed by Alice.' });
    expect(describeHistory({ ...noChanges(), profile: { before: { name: 'A' }, after: { name: 'B', image: 'x' } } }, [A, B], names)).toEqual({
      kind: 'profile',
      text: 'Profile updated: name, image. Signed by Alice and Bob.',
    });
    expect(describeHistory({ ...noChanges(), control: { before: nOfK(1, [A]), after: nOfK(1, [B]) } }, [A], names)).toEqual({
      kind: 'policy',
      text: 'Management policy stays 1 of 1. Removed: Alice. Added: Bob. Signed by Alice.',
    });
    expect(describeHistory({ ...noChanges(), dissolve: true }, [A], names)).toEqual({ kind: 'dissolved', text: 'Group dissolved by Alice.' });
  });

  it('reads a resignation by the key that resigned, without naming signers', () => {
    expect(describeHistory({ ...noChanges(), resigned: B }, [B], names)).toEqual({ kind: 'resign', text: 'Bob resigned as admin.' });
    expect(describeHistory({ ...noChanges(), resigned: D }, [D], names)).toEqual({
      kind: 'resign',
      text: `${shortHash(drepIdForCredential(key(D)))} resigned as admin.`,
    });
    expect(describeHistory({ ...noChanges(), resigned: null }, [], names)).toEqual({ kind: 'resign', text: 'An admin resigned.' });
    expect(describeAction({ ...noChanges(), resigned: B }, names)).toEqual(['Bob resigns as admin.']);
  });
});

describe('policyKeyParts', () => {
  it('links the admins that are DReps, marks the resigned ones and keeps the threshold', () => {
    const parts = policyKeyParts(nOfK(2, [A, B, D]), names, [B]);
    expect(parts).toEqual({
      ratio: '2 of 3',
      keys: [
        { key: A, label: 'Alice', href: `/dreps/${drepIdForCredential(key(A))}/`, resigned: false },
        { key: B, label: 'Bob', href: `/dreps/${drepIdForCredential(key(B))}/`, resigned: true },
        { key: D, label: shortHash(drepIdForCredential(key(D))), href: null, resigned: false },
      ],
    });
  });

  it('leaves a nested policy to the words', () => {
    expect(policyKeyParts({ kind: 'all', children: [sig(A), { kind: 'after', slot: '5' }] }, names, [])).toBeNull();
  });
});
