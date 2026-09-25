import { describe, it, expect } from 'vitest';
import { normalizeHandleInput, validateHandle, GRANDFATHERED } from './handle.js';

const P = 'drep1yftc8zs7gjcj4a9nxzplz4wg6cwweya0kxp8adnw59vsyrqvrysud';
const OTHER = 'drep1y26ppxzudkhtak4y7kc2rag9ezq7szje78aetxge3pg5w7qwthkqv';

describe('normalizeHandleInput', () => {
  it('trims, lowercases and strips one leading drep.link/ prefix', () => {
    expect(normalizeHandleInput('  ADAtainment ')).toBe('adatainment');
    expect(normalizeHandleInput('drep.link/Foo')).toBe('foo');
    expect(normalizeHandleInput('https://drep.link/foo/')).toBe('foo');
  });
  it('does not rewrite invalid characters, validation rejects them', () => {
    expect(normalizeHandleInput('foo bar')).toBe('foo bar');
  });
});

describe('validateHandle', () => {
  it('accepts a normal handle', () => {
    expect(validateHandle('adatainment', null)).toEqual({ ok: true });
  });
  it('rejects bad shapes', () => {
    for (const h of ['foo bar', '-foo', 'foo-', 'foo--bar', 'föö', 'foo_bar', 'drep_vkh1abc', 'FOO', ''])
      expect(validateHandle(h, null)).toEqual({ ok: false, reason: 'shape' });
  });
  it('enforces 3 to 40 characters', () => {
    expect(validateHandle('ab', null)).toEqual({ ok: false, reason: 'length' });
    expect(validateHandle('a'.repeat(41), null)).toEqual({ ok: false, reason: 'length' });
    expect(validateHandle('a'.repeat(40), null)).toEqual({ ok: true });
  });
  it('lets the grandfathered short handles through only for their owner', () => {
    expect(GRANDFATHERED.get('p')).toBe(P);
    expect(validateHandle('p', P)).toEqual({ ok: true });
    expect(validateHandle('p', OTHER)).toEqual({ ok: false, reason: 'length' });
    expect(validateHandle('42', null)).toEqual({ ok: false, reason: 'length' });
  });
  it('rejects the id namespace', () => {
    for (const h of ['drep1abc', 'drep-vkh1abc', 'drep-script'])
      expect(validateHandle(h, null)).toEqual({ ok: false, reason: 'id_namespace' });
    expect(validateHandle('drepper', null)).toEqual({ ok: true });
  });
  it('rejects reserved handles', () => {
    expect(validateHandle('emurgo', null)).toEqual({ ok: false, reason: 'reserved' });
  });
});
