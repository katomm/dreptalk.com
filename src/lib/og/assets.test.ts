// loadCardImage decides whether a bundled asset can be embedded in a card. resvg
// (the workers-og rasterizer) decodes only PNG and JPEG, so anything else, a miss,
// or an error must return null and let the card render without the illustration.
import { describe, expect, it } from 'vitest';
import { loadCardImage } from './assets.js';

const ORIGIN = 'https://dreptalk.com/';
const BYTES = new Uint8Array([137, 80, 78, 71]);

function fetcher(body: BodyInit | null, init: ResponseInit): Fetcher {
  return { fetch: async () => new Response(body, init) } as unknown as Fetcher;
}

describe('loadCardImage', () => {
  it('inlines a PNG asset as a data URL', async () => {
    const f = fetcher(BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    expect(await loadCardImage(f, ORIGIN, '/help/og/voting.png')).toMatch(/^data:image\/png;base64,/);
  });

  it('inlines a JPEG asset as a data URL', async () => {
    const f = fetcher(BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    expect(await loadCardImage(f, ORIGIN, '/x.jpg')).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('ignores a charset suffix on the content type', async () => {
    const f = fetcher(BYTES, { status: 200, headers: { 'content-type': 'image/png; charset=binary' } });
    expect(await loadCardImage(f, ORIGIN, '/x.png')).toMatch(/^data:image\/png;base64,/);
  });

  it('returns null for a webp (resvg cannot decode it)', async () => {
    const f = fetcher(BYTES, { status: 200, headers: { 'content-type': 'image/webp' } });
    expect(await loadCardImage(f, ORIGIN, '/x.webp')).toBeNull();
  });

  it('returns null on a 404', async () => {
    const f = fetcher(null, { status: 404 });
    expect(await loadCardImage(f, ORIGIN, '/missing.png')).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    const f = { fetch: async () => { throw new Error('boom'); } } as unknown as Fetcher;
    expect(await loadCardImage(f, ORIGIN, '/x.png')).toBeNull();
  });

  it('returns null when no assets binding is provided', async () => {
    expect(await loadCardImage(undefined, ORIGIN, '/x.png')).toBeNull();
  });
});
