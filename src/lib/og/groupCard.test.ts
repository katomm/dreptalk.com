import { describe, expect, it } from 'vitest';
import { groupCardModel, groupCardVersion, type GroupCardInput } from './groupCard.js';

const G: GroupCardInput = {
  groupId: 'group1mz6spxh0f5huee8c4krz62tpzwr2g85k78lxqvp7asypkt7vsjqsqqq3f046h',
  name: 'Commons Council',
  description: 'First paragraph.\n\nSecond paragraph.',
  mode: 'open',
  status: 'active',
  members: 4,
  memberPower: '90000000000',
  closing: false,
  imageHash: null,
};

describe('group card', () => {
  it('shows the name, the short id, one line of the description and the stats', () => {
    const m = groupCardModel(G, { avatarDataUrl: 'data:x' });
    expect(m.name).toBe('Commons Council');
    expect(m.idShort).toMatch(/^group1/);
    expect(m.bio).toBe('First paragraph. Second paragraph.');
    expect(m.stats.map((s) => s.icon)).toEqual(['power', 'members', 'mode']);
    expect(m.stats[1]).toMatchObject({ value: '4', label: 'members' });
    expect(m.stats[2]).toMatchObject({ value: 'Open', label: 'anyone can join' });
  });

  it('falls back to the short id without a profile and marks a dissolved group', () => {
    const m = groupCardModel({ ...G, name: null, description: null, status: 'dissolved' }, { avatarDataUrl: 'data:x' });
    expect(m.name).toMatch(/^group1/);
    expect(m.idShort).toBeNull();
    expect(m.bio).toBeNull();
    expect(m.stats[2]).toMatchObject({ value: 'Dissolved', label: '' });
  });

  it('changes its version when anything shown changes', () => {
    const v = groupCardVersion(G);
    expect(groupCardVersion({ ...G })).toBe(v);
    expect(groupCardVersion({ ...G, members: 5 })).not.toBe(v);
    expect(groupCardVersion({ ...G, memberPower: '1' })).not.toBe(v);
    expect(groupCardVersion({ ...G, imageHash: 'ab' })).not.toBe(v);
  });
});
