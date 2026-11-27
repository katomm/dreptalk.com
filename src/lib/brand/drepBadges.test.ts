import { describe, it, expect } from 'vitest';
import { buildDrepBadges, drepShareText, NAME_CAP } from './drepBadges.js';

describe('buildDrepBadges', () => {
  it('points every badge at the DRep short link', () => {
    const badges = buildDrepBadges('adatainment', 'ADAtainment');
    expect(badges).toHaveLength(3);
    for (const b of badges) {
      expect(b.html).toContain('href="https://drep.link/adatainment"');
      expect(b.html.match(/<a /g)).toHaveLength(1);
      expect(b.html).not.toMatch(/<script|<iframe/i);
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
    expect(drepShareText('adatainment')).toContain('https://drep.link/adatainment');
  });

  it('refuses a handle that is not routable', () => {
    expect(drepShareText('')).toBeNull();
  });
});

describe('buildDrepBadges with long names and handles', () => {
  const LONG_HANDLE = 'governance-representative-cardano-xyz12';
  const LONG_NAME = 'GovernanceRepresentativeCardanoXYZ123456';

  // A name without spaces is wider than the 300px card at 17px bold.
  it('lets long headings and the short link wrap instead of overflowing', () => {
    const [, sidebar, banner] = buildDrepBadges(LONG_HANDLE, LONG_NAME);
    expect(sidebar.html).toContain('overflow-wrap:anywhere');
    expect(banner.html).toContain('overflow-wrap:anywhere');
    expect(banner.html).not.toMatch(/white-space:nowrap;">drep\.link\//);
  });

  // The footer reveal has its own class, so its wider sizing never leaks into
  // a /brand badge on the same page.
  it('styles the footer reveal under its own class', () => {
    const [footer] = buildDrepBadges(LONG_HANDLE, null);
    expect(footer.html).not.toContain('.dtlk');
    expect(footer.html).toContain('class="dtdk"');
  });
});
