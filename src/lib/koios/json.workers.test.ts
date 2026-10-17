/// <reference types="@cloudflare/workers-types" />
// parseKoiosJson depends on the reviver's source text. Node has it, but the
// app and gov-sync run in workerd, so this proves it there: without it every
// Koios answer with an amount above 2^53 would throw.
import { describe, it, expect } from 'vitest';
import { parseKoiosJson } from './json.js';

describe('parseKoiosJson in workerd', () => {
  it('reads an integer above 2^53 exactly', () => {
    expect(parseKoiosJson('[{"circulation":36797328639342681}]')).toEqual([
      { circulation: '36797328639342681' },
    ]);
  });
});
