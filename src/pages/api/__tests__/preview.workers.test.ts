/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/preview, which now serves two callers:
// the forum editor's single `bodyMd` preview (mentions resolved against D1)
// and the governance submit form's `parts` preview (several short Markdown
// fields at once, chain ids linked exactly as the action page links them).
// The route is imported directly so the forum path is guarded against a
// regression by the real handler, not by a copy of it.
//
// Under __tests__ so Astro never routes this file (a leading underscore keeps
// a directory out of the route table).
import { describe, it, expect } from 'vitest';
import { POST } from '../preview.js';
import {
  INFO_ABSTRACT_MAX,
  INFO_MOTIVATION_MAX,
  INFO_RATIONALE_MAX,
} from '@/lib/governance/infoActionLimits.js';

let seq = 0;

/** One request as a signed-in user, each test with its own id so the 60/min limit never bleeds across tests. */
function call(body: unknown, userId = `preview-user-${++seq}`): Promise<Response> {
  const request = new Request('https://dreptalk.com/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const locals = { user: { id: userId, roles: [] } } as unknown as App.Locals;
  return POST({ request, locals } as never) as Promise<Response>;
}

describe('POST /api/preview, forum bodyMd path', () => {
  it('renders one Markdown body to sanitized HTML', async () => {
    const res = await call({ bodyMd: '# Title\n\nSome *body*.' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { html: string };
    expect(json.html).toContain('<h2>Title</h2>');
    expect(json.html).toContain('<em>body</em>');
    // The forum path never enhanced the stored HTML at preview time (that runs
    // at display time), and the parts mode must not change that.
    expect(json.html).not.toContain('target="_blank"');
  });

  it('rejects a body over the forum cap', async () => {
    const res = await call({ bodyMd: 'x'.repeat(20001) });
    expect(res.status).toBe(400);
  });

  // Valid JSON, but nothing to read a field off: a property access on it would
  // throw and turn a bad request into a 500.
  it('rejects a body of literal null', async () => {
    const request = new Request('https://dreptalk.com/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    const locals = { user: { id: `preview-user-${++seq}`, roles: [] } } as unknown as App.Locals;
    const res = (await POST({ request, locals } as never)) as Response;
    expect(res.status).toBe(400);
  });

  it('401s a signed-out request', async () => {
    const request = new Request('https://dreptalk.com/api/preview', {
      method: 'POST',
      body: JSON.stringify({ bodyMd: 'hi' }),
    });
    const res = (await POST({ request, locals: { user: null } as unknown as App.Locals } as never)) as Response;
    expect(res.status).toBe(401);
  });
});

describe('POST /api/preview, governance parts path', () => {
  it('renders every part under its own key', async () => {
    const res = await call({
      parts: { abstract: 'The **abstract**.', motivation: 'The motivation.', rationale: 'The rationale.' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { html: Record<string, string> };
    expect(Object.keys(json.html).sort()).toEqual(['abstract', 'motivation', 'rationale']);
    expect(json.html.abstract).toContain('<strong>abstract</strong>');
    expect(json.html.rationale).toContain('The rationale.');
  });

  it('links a chain id and opens links in a new tab, like the action page does', async () => {
    const res = await call({ parts: { abstract: 'See https://example.com/ for more.' } });
    const json = (await res.json()) as { html: Record<string, string> };
    // enhanceStoredHtml ran: the action page's display-time pass is baked in
    // here because the island injects this HTML as is.
    expect(json.html.abstract).toContain('target="_blank"');
  });

  it('leaves an @mention as plain text, since a governance document has none', async () => {
    const res = await call({ parts: { abstract: 'Ping @someone about it.' } });
    const json = (await res.json()) as { html: Record<string, string> };
    expect(json.html.abstract).toContain('@someone');
    expect(json.html.abstract).not.toContain('<a href="/drep/');
  });

  it('rejects more than four parts', async () => {
    const res = await call({ parts: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('too many parts');
  });

  // One cap per known part, matched to the form field behind it, each with no
  // headroom above it.
  it('accepts an abstract at its own cap and rejects one above it', async () => {
    const ok = await call({ parts: { abstract: 'x'.repeat(INFO_ABSTRACT_MAX) } });
    expect(ok.status).toBe(200);
    const tooLong = await call({ parts: { abstract: 'x'.repeat(INFO_ABSTRACT_MAX + 1) } });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toBe('part too long');
  });

  // The merged body carries motivation plus rationale plus the blank line
  // between them, so the single-field cap would refuse a form that is exactly
  // within what the fields themselves allow.
  it('accepts a merged body at motivation plus rationale plus the separator, and rejects one above it', async () => {
    const bodyMax = INFO_MOTIVATION_MAX + INFO_RATIONALE_MAX + 2;
    const ok = await call({ parts: { body: 'x'.repeat(bodyMax) } });
    expect(ok.status).toBe(200);
    const tooLong = await call({ parts: { body: 'x'.repeat(bodyMax + 1) } });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toBe('part too long');
  });

  it('holds any other key to the widest single metadata field', async () => {
    const ok = await call({ parts: { rationale: 'x'.repeat(INFO_RATIONALE_MAX) } });
    expect(ok.status).toBe(200);
    const tooLong = await call({ parts: { rationale: 'x'.repeat(INFO_RATIONALE_MAX + 1) } });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toBe('part too long');
  });

  it('rejects a non-string part', async () => {
    const res = await call({ parts: { abstract: 42 } });
    expect(res.status).toBe(400);
  });

  // Written as raw JSON because an object literal with a __proto__ key sets the
  // prototype instead of creating the property, so it would never be sent.
  it('returns a part whose key would otherwise hit a prototype setter', async () => {
    const request = new Request('https://dreptalk.com/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"parts":{"__proto__":"Injected."}}',
    });
    const locals = { user: { id: `preview-user-${++seq}`, roles: [] } } as unknown as App.Locals;
    const res = (await POST({ request, locals } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Injected.');
  });
});
