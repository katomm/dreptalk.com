import { describe, it, expect } from 'vitest';
import { parseKoiosJson } from './json';

// Bodies are raw JSON text on purpose: a JS number literal above 2^53 would
// already be rounded before the parser ever saw it.
describe('parseKoiosJson', () => {
  it('keeps every integer above 2^53 as its exact decimal string', () => {
    const text =
      '{"big":18446744073709551615,"circulation":21391325252789667,' +
      '"neg":-21391325252789667,"list":[9007199254740993,[36797328639342681]]}';
    expect(parseKoiosJson(text)).toEqual({
      big: '18446744073709551615',
      circulation: '21391325252789667',
      neg: '-21391325252789667',
      list: ['9007199254740993', ['36797328639342681']],
    });
  });

  it('leaves strings, safe integers, decimals, booleans and null as JSON.parse does', () => {
    const text =
      '{"s":"21391325252789667","safe":9007199254740991,"zero":0,' +
      '"pct":33.333333333333336,"t":true,"n":null}';
    expect(parseKoiosJson(text)).toEqual(JSON.parse(text));
  });

  it('reads a large integer at the root', () => {
    expect(parseKoiosJson('36797328639342681')).toBe('36797328639342681');
  });

  it('refuses an integer it cannot read digit for digit', () => {
    expect(() => parseKoiosJson('{"a":1e20}')).toThrow('1e20');
    expect(() => parseKoiosJson('{"a":9.007199254740993e15}')).toThrow('9.007199254740993e15');
  });

  it('still throws on malformed JSON', () => {
    expect(() => parseKoiosJson('{"a":')).toThrow(SyntaxError);
  });
});
