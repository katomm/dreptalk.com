import { describe, expect, it } from 'vitest';
import { renderLlmsText, type LlmsInput } from './text.js';

const origin = 'https://dreptalk.com';

const input: LlmsInput = {
  guides: [
    { id: 'delegate', title: 'Delegate to a DRep', description: 'Second guide.', category: 'Start here', order: 2 },
    { id: 'become-a-drep', title: 'Become a DRep', description: 'First guide.', category: 'Start here', order: 1 },
    { id: 'badges', title: 'Badges', description: 'About the site.', category: 'About DRepTalk', order: 1 },
  ],
  glossary: [
    { id: 'drep', term: 'DRep', description: 'A delegated representative.', group: 'Roles and bodies', order: 1 },
  ],
  editions: [
    {
      edition: 1,
      epochFrom: 508,
      epochTo: 513,
      title: 'Delegation grows',
      teaser: 'Short teaser.',
      standfirst: 'Long standfirst.',
    },
    { edition: 2, epochFrom: 514, epochTo: 516, title: 'Second window', standfirst: 'Only a standfirst.' },
  ],
};

describe('renderLlmsText', () => {
  const text = renderLlmsText(origin, input);

  it('starts with the H1 and a blockquote summary, as the llms.txt format asks', () => {
    expect(text.startsWith('# DRepTalk\n\n> ')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('lists guides by category in frontmatter order and skips empty categories', () => {
    const lines = text.split('\n');
    const become = lines.indexOf(`- [Become a DRep](${origin}/help/become-a-drep/): First guide.`);
    const delegate = lines.indexOf(`- [Delegate to a DRep](${origin}/help/delegate/): Second guide.`);
    expect(become).toBeGreaterThan(-1);
    expect(delegate).toBe(become + 1);
    expect(text).toContain('### Start here');
    expect(text).toContain('### About DRepTalk');
    expect(text).not.toContain('### For DReps');
  });

  it('lists editions newest first with the teaser, falling back to the standfirst', () => {
    const second = text.indexOf('/governance-review/epochs-514-516/): Only a standfirst.');
    const first = text.indexOf('/governance-review/epochs-508-513/): Short teaser.');
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
    expect(text).toContain('[Edition 1, epochs 508 to 513: Delegation grows]');
  });

  it('groups glossary entries and links the sitemaps under Optional', () => {
    expect(text).toContain(`### Roles and bodies\n\n- [DRep](${origin}/glossary/drep/): A delegated representative.`);
    expect(text).toContain(`## Optional\n\n- [Sitemap](${origin}/sitemap.xml)`);
    expect(text).toContain(`${origin}/sitemap-cip100.xml`);
  });

  it('keeps every entry on one line and never breaks link text', () => {
    const out = renderLlmsText(origin, {
      guides: [
        {
          id: 'x',
          title: 'A [bracketed] title',
          description: 'Line one\nline two',
          category: 'For DReps',
          order: 1,
        },
      ],
      glossary: [],
      editions: [],
    });
    expect(out).toContain(`- [A bracketed title](${origin}/help/x/): Line one line two`);
  });
});
