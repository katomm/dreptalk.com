import { describe, it, expect } from 'vitest';
import { parseLatestEdition, fetchLatestEdition } from './latestEdition.js';

describe('parseLatestEdition', () => {
  it('accepts a well-formed body', () => {
    expect(parseLatestEdition({ edition: 43, slug: 'epochs-656-658', title: 'T' })).toEqual({
      edition: 43,
      slug: 'epochs-656-658',
      title: 'T',
    });
  });

  it('rejects missing fields, wrong types and a slug outside the epochs pattern', () => {
    expect(parseLatestEdition(null)).toBeNull();
    expect(parseLatestEdition({ edition: '43', slug: 'epochs-1-3', title: 'T' })).toBeNull();
    expect(parseLatestEdition({ edition: 0, slug: 'epochs-1-3', title: 'T' })).toBeNull();
    expect(parseLatestEdition({ edition: 43, slug: '../admin', title: 'T' })).toBeNull();
    expect(parseLatestEdition({ edition: 43, slug: 'epochs-1-3', title: '' })).toBeNull();
  });
});

describe('fetchLatestEdition', () => {
  const site = (res: Response) => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return res;
    };
    return { urls, fetcher: { fetch } };
  };

  it('reads the endpoint on the site origin', async () => {
    const { urls, fetcher } = site(Response.json({ edition: 43, slug: 'epochs-656-658', title: 'T' }));
    expect(await fetchLatestEdition(fetcher, 'https://dreptalk.com')).toMatchObject({ edition: 43 });
    expect(urls).toEqual(['https://dreptalk.com/api/review/latest.json']);
  });

  it('returns null when the site has no edition yet', async () => {
    const { fetcher } = site(Response.json({ error: 'no edition' }, { status: 404 }));
    expect(await fetchLatestEdition(fetcher, 'https://dreptalk.com')).toBeNull();
  });

  it('throws on any other failure, so the phase records it', async () => {
    const { fetcher } = site(new Response('boom', { status: 500 }));
    await expect(fetchLatestEdition(fetcher, 'https://dreptalk.com')).rejects.toThrow(/500/);
    const bad = site(Response.json({ edition: 'x' }));
    await expect(fetchLatestEdition(bad.fetcher, 'https://dreptalk.com')).rejects.toThrow(/malformed/);
  });
});
