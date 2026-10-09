import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown.js';
import { excerptFromMarkdown, excerptFromHtmlWithMarkdown } from './excerpt.js';

describe('excerptFromMarkdown', () => {
  it('strips emphasis, headings, code ticks and images, keeps link text', () => {
    const md = '# Title\n\nThis is **bold**, _italic_ and `code` with [a link](https://x.io/a) ![img](https://x.io/i.png) done.';
    expect(excerptFromMarkdown(md)).toBe('Title This is bold, italic and code with a link done.');
  });

  it('keeps snake_case and list text', () => {
    expect(excerptFromMarkdown('- my_var_name stays\n- second')).toBe('my_var_name stays second');
  });

  it('skips leading pointer lines (bold label plus URL, bare link text)', () => {
    const md = '**Proposal as pdf:** https://example.com/p.pdf\n\n[Proposal as pdf](https://example.com/p.pdf)\n\nFunds the maintenance of the indexer.';
    expect(excerptFromMarkdown(md)).toBe('Funds the maintenance of the indexer.');
  });

  it('skips italic, bold-italic, plain, reference and labelled link-only lines', () => {
    const body = '\n\nFunds the indexer.';
    expect(excerptFromMarkdown('[Read the application](https://example.com/p.pdf)' + body)).toBe('Funds the indexer.');
    expect(excerptFromMarkdown('*[Read the application](https://example.com/p.pdf)*' + body)).toBe('Funds the indexer.');
    expect(excerptFromMarkdown('***[Read the application](https://example.com/p.pdf)***' + body)).toBe('Funds the indexer.');
    expect(excerptFromMarkdown('[Read the application][app]\n\n[app]: https://example.com/p.pdf' + body)).toBe('Funds the indexer.');
    expect(excerptFromMarkdown('Proposal as pdf: https://example.com/p.pdf' + body)).toBe('Funds the indexer.');
  });

  it('keeps emphasised prose that ends in a colon', () => {
    expect(excerptFromMarkdown('We **propose**: funding for X')).toBe('We propose: funding for X');
  });

  it('keeps an undefined bracket expression as literal text', () => {
    expect(excerptFromMarkdown('[Funding pending]')).toBe('[Funding pending]');
  });

  it('drops multi-line reference definitions completely', () => {
    const md = 'Funds the [indexer][i].\n\n[i]: https://example.com/i\n    "Long title"';
    expect(excerptFromMarkdown(md)).toBe('Funds the indexer.');
  });

  it('keeps a line where a link sits inside prose', () => {
    expect(excerptFromMarkdown('See [the plan](https://e.com/x) for details.')).toBe('See the plan for details.');
  });

  it('truncates within maxLen including the ellipsis', () => {
    const out = excerptFromMarkdown('**alpha** beta gamma delta', 16);
    expect(out).toBe('alpha beta...');
  });
});

describe('excerptFromMarkdown blocks', () => {
  it('keeps a line break inside one block', () => {
    expect(excerptFromMarkdown('[We fund](https://e.com)\nthe indexer.')).toBe('We fund the indexer.');
  });

  it('recognises a link split over two lines as a pointer', () => {
    expect(excerptFromMarkdown('[Read the\napplication](https://e.com)\n\nFunds indexer.')).toBe('Funds indexer.');
  });

  it('excludes code blocks but keeps inline code', () => {
    expect(excerptFromMarkdown('```\nconst x = 1;\n```\n\nUse `npm` here.')).toBe('Use npm here.');
  });
});

describe('excerptFromHtmlWithMarkdown', () => {
  it('removes literal markdown markers and skips the pdf pointer paragraph', () => {
    const html = '<p>**Proposal as pdf:** https://example.com/p.pdf</p><p>Funds the **indexer** work.</p>';
    expect(excerptFromHtmlWithMarkdown(html)).toBe('Funds the indexer work.');
  });

  it('skips a rendered link-only block and keeps prose with a link', () => {
    expect(excerptFromHtmlWithMarkdown('<p><a href="https://e.com">Read it</a></p><p>See <a href="https://e.com">plan</a> now.</p>')).toBe('See plan now.');
  });

  it('skips the generated intro and the pdf pointer after it (sync output shape)', () => {
    const md = [
      '**On-chain governance action** (Treasury Withdrawals).',
      '',
      '**Proposal as pdf:** https://example.com/p.pdf',
      '',
      'Funds the indexer.',
      '',
      '- Deposit: 100,000 ada',
    ].join('\n');
    expect(excerptFromHtmlWithMarkdown(renderMarkdown(md))).toBe('Funds the indexer. Deposit: 100,000 ada');
    const literal = '<p>**On-chain governance action** (Treasury Withdrawals).</p><p>**Proposal as pdf:** https://example.com/p.pdf</p><p>Funds the indexer.</p>';
    expect(excerptFromHtmlWithMarkdown(literal)).toBe('Funds the indexer.');
  });
});
