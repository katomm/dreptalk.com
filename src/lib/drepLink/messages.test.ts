import { describe, it, expect } from 'vitest';
import { claimErrorMessage } from './messages.js';

const ALL = ['taken', 'reserved', 'length', 'shape', 'id_namespace', 'unchanged', 'cooldown', 'previous_pending', 'stale', 'not_open', 'not_synced', 'not_registered', 'rate_limited'];

describe('claimErrorMessage', () => {
  it('explains each refusal in plain words', () => {
    expect(claimErrorMessage('taken', null)).toBe('This drep.link is already taken.');
    expect(claimErrorMessage('reserved', null)).toBe('This name is reserved.');
    expect(claimErrorMessage('length', null)).toBe('Use 3 to 40 characters.');
    expect(claimErrorMessage('cooldown', 1_800_000_000)).toMatch(/^You can change your drep\.link again on /);
    expect(claimErrorMessage('previous_pending', 1_800_000_000)).toMatch(/your previous link still redirects until /);
    expect(claimErrorMessage('stale', null)).toBe('Your link changed in the meantime. Reload the page and try again.');
    expect(claimErrorMessage('whatever', null)).toBe('Something went wrong. Please try again.');
  });
  it('has a specific text for every error the API can return', () => {
    for (const e of ALL) expect(claimErrorMessage(e, 1_800_000_000)).not.toBe('Something went wrong. Please try again.');
  });
  it('follows the copy rules', () => {
    for (const e of ALL) expect(claimErrorMessage(e, 1_800_000_000)).not.toMatch(/[;\u2013\u2014]/);
  });
});
