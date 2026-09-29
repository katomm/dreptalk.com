import { describe, it, expect } from 'vitest';
import { buildDrepBadges, drepShareText, NAME_CAP } from './drepBadges.js';

const DASHES = /—|–|―|&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;/;

describe('buildDrepBadges', () => {
  it('points every badge at the DRep short link', () => {
    const badges = buildDrepBadges('adatainment', 'ADAtainment');
    expect(badges).toHaveLength(3);
    for (const b of badges) {
      expect(b.html).toContain('href="https://drep.link/adatainment"');
      expect(b.html.match(/<a /g)).toHaveLength(1);
      expect(b.html).not.toMatch(DASHES);
      expect(b.html).not.toMatch(/<script|<iframe/i);
      expect(b.note).not.toContain(';');
    }
  });

  it('uses gradient ids that cannot collide with the /brand badges', () => {
    const html = buildDrepBadges('adatainment', null).map((b) => b.html).join('');
    expect(html).not.toMatch(/id="dtg-(fb|sc|bn)"/);
    expect(html).toMatch(/id="dtd-(fb|sc|bn)"/);
  });

  // Review Focus 1: the name is on-chain metadata the DRep controls, and the
  // snippet is rendered as HTML in our own preview.
  it('escapes a name that carries markup', () => {
    const html = buildDrepBadges('evil', '<b>x</b> "q" & y').map((b) => b.html).join('');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &quot;q&quot; &amp; y');
  });

  it('caps a very long name before escaping it', () => {
    const long = 'A'.repeat(300);
    const html = buildDrepBadges('long', long).map((b) => b.html).join('');
    expect(html).not.toContain('A'.repeat(NAME_CAP + 1));
    expect(html).toContain(`${'A'.repeat(NAME_CAP - 1)}…`);
  });

  it('never cuts an escape sequence in half', () => {
    const name = `${'x'.repeat(NAME_CAP - 1)}&tail`;
    const html = buildDrepBadges('cut', name).map((b) => b.html).join('');
    expect(html).not.toMatch(/&am(?!p;)/);
  });

  it('falls back to the short link when the DRep has no name', () => {
    const html = buildDrepBadges('adatainment', null).map((b) => b.html).join('');
    expect(html).toContain('drep.link/adatainment');
  });

  // Review Focus 2.
  it('refuses a handle that is not routable', () => {
    expect(buildDrepBadges('', 'X')).toEqual([]);
    expect(buildDrepBadges('Not-Lower', 'X')).toEqual([]);
    expect(buildDrepBadges('a/b', 'X')).toEqual([]);
  });
});

describe('drepShareText', () => {
  it('fills in the short link', () => {
    expect(drepShareText('adatainment')).toBe('See how I vote on Cardano governance and why: https://drep.link/adatainment');
  });

  it('refuses a handle that is not routable', () => {
    expect(drepShareText('')).toBeNull();
  });
});
