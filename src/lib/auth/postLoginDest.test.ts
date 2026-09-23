import { describe, it, expect } from 'vitest';
import { safeNextPath, postLoginDest, loginHref } from './postLoginDest.js';

describe('safeNextPath', () => {
  it('keeps a same-site path with query and hash', () => {
    expect(safeNextPath('/notifications/#notification-settings')).toBe('/notifications/#notification-settings');
    expect(safeNextPath('/governance-review/epochs-1-3/?x=1')).toBe('/governance-review/epochs-1-3/?x=1');
  });

  it('refuses anything that could leave the site', () => {
    for (const bad of [
      null,
      '',
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example/',
      '/\\/evil.example/',
      'javascript:alert(1)',
      'notifications/',
      '/%0a/evil',
      ' /home/',
    ]) {
      expect(safeNextPath(bad)).toBeNull();
    }
  });

  it('refuses a way back to the login page itself', () => {
    expect(safeNextPath('/login/')).toBeNull();
    expect(safeNextPath('/login/?next=/home/')).toBeNull();
  });
});

describe('postLoginDest', () => {
  it('follows a valid next parameter and falls back to /home/', () => {
    expect(postLoginDest('?next=%2Fnotifications%2F%23notification-settings')).toBe('/notifications/#notification-settings');
    expect(postLoginDest('?role=delegator&next=/dreps/')).toBe('/dreps/');
    expect(postLoginDest('?next=https://evil.example/')).toBe('/home/');
    expect(postLoginDest('')).toBe('/home/');
  });
});

describe('loginHref', () => {
  it('encodes the target so its hash survives the round trip', () => {
    const href = loginHref('/notifications/#notification-settings');
    expect(href).toBe('/login/?next=%2Fnotifications%2F%23notification-settings');
    expect(postLoginDest(href.slice(href.indexOf('?')))).toBe('/notifications/#notification-settings');
  });
});
