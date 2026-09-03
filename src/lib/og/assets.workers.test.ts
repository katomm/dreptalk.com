// loadAvatar against the real miniflare R2 binding. The card rasterizer (resvg)
// decodes only PNG and JPEG, so those are inlined as stored; anything else needs a
// PNG rendition (via the Images binding, cached in R2) or the whole OG card renders
// to an empty PNG. Without a usable rendition the identicon is the fallback.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { loadAvatar } from './assets.js';
import { AVATAR_KEY_PREFIX, type ImagesLike, ogAvatarKey } from '../dreps/avatarStore.js';
import { identiconDataUri } from '../identity/identicon.js';

const bucket = () => env.AVATARS as R2Bucket;
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const SEED = 'drep1abcdef';

async function store(hash: string, contentType: string) {
  await bucket().put(AVATAR_KEY_PREFIX + hash, BYTES, { httpMetadata: { contentType } });
}

/** Images binding stub: records its calls and returns PNG_BYTES as the output. */
function images(out: Uint8Array | null = PNG_BYTES) {
  const calls: { format: string; width?: number }[] = [];
  const binding = {
    input: (_stream: ReadableStream) => ({
      transform(opts: { width?: number }) {
        return {
          output: async (o: { format: string }) => {
            calls.push({ format: o.format, width: opts.width });
            return { response: () => new Response(out ?? new Uint8Array()) };
          },
        };
      },
    }),
  } as unknown as ImagesLike;
  return { binding, calls };
}

describe('loadAvatar', () => {
  it('inlines a stored PNG as a data URL', async () => {
    const hash = 'a'.repeat(64);
    await store(hash, 'image/png');
    expect(await loadAvatar(bucket(), SEED, hash)).toMatch(/^data:image\/png;base64,/);
  });

  it('inlines a stored JPEG as a data URL', async () => {
    const hash = 'b'.repeat(64);
    await store(hash, 'image/jpeg');
    expect(await loadAvatar(bucket(), SEED, hash)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('re-encodes a stored WebP to a PNG rendition and caches it in R2', async () => {
    const hash = 'c'.repeat(64);
    await store(hash, 'image/webp');
    const { binding, calls } = images();

    const out = await loadAvatar(bucket(), SEED, hash, binding);
    expect(out).toMatch(/^data:image\/png;base64,/);
    expect(calls).toEqual([{ format: 'image/png', width: 256 }]);

    const cached = await bucket().get(ogAvatarKey(hash));
    expect(cached?.httpMetadata?.contentType).toBe('image/png');
  });

  it('reuses the cached rendition instead of re-encoding again', async () => {
    const hash = '1'.repeat(64);
    await store(hash, 'image/webp');
    await loadAvatar(bucket(), SEED, hash, images().binding);

    const second = images();
    expect(await loadAvatar(bucket(), SEED, hash, second.binding)).toMatch(/^data:image\/png;base64,/);
    expect(second.calls).toEqual([]);
  });

  it('renders AVIF and GIF through the same rendition path', async () => {
    await store('d'.repeat(64), 'image/avif');
    await store('e'.repeat(64), 'image/gif');
    expect(await loadAvatar(bucket(), SEED, 'd'.repeat(64), images().binding)).toMatch(/^data:image\/png;base64,/);
    expect(await loadAvatar(bucket(), SEED, 'e'.repeat(64), images().binding)).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to the identicon for a WebP when no Images binding is available', async () => {
    const hash = '2'.repeat(64);
    await store(hash, 'image/webp');
    const out = await loadAvatar(bucket(), SEED, hash);
    expect(out).not.toMatch(/^data:image\/webp/);
    expect(out).toBe(identiconDataUri(SEED, 160));
  });

  it('falls back to the identicon when the re-encode yields nothing', async () => {
    const hash = '3'.repeat(64);
    await store(hash, 'image/webp');
    expect(await loadAvatar(bucket(), SEED, hash, images(null).binding)).toBe(identiconDataUri(SEED, 160));
    expect(await bucket().get(ogAvatarKey(hash))).toBeNull();
  });

  it('falls back to the identicon when the transform throws', async () => {
    const hash = '4'.repeat(64);
    await store(hash, 'image/webp');
    const throwing = { input: () => { throw new Error('boom'); } } as unknown as ImagesLike;
    expect(await loadAvatar(bucket(), SEED, hash, throwing)).toBe(identiconDataUri(SEED, 160));
  });

  it('falls back to the identicon on a miss, a missing hash, or no bucket', async () => {
    const identicon = identiconDataUri(SEED, 160);
    expect(await loadAvatar(bucket(), SEED, 'f'.repeat(64))).toBe(identicon);
    expect(await loadAvatar(bucket(), SEED, null)).toBe(identicon);
    expect(await loadAvatar(undefined, SEED, 'a'.repeat(64))).toBe(identicon);
  });
});
