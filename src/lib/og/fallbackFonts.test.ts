// The OG cards ship a Latin-only font subset, so a name like 忠実 used to render
// as an empty gap. These cover both halves of the fix: deciding which script needs
// a fallback face (and not fetching one when the bundled fonts already cover the
// text), and proving that the fetched face actually paints the glyphs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearFallbackFontCache, fallbackRequests, loadFallbackFonts } from './fallbackFonts.js';
import { coveredCodepoints } from './fontCoverage.js';
import type { OgFont } from './fonts.js';

const here = import.meta.dirname;
const read = (file: string): ArrayBuffer => {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

// The fonts every card ships with, and a five-glyph Noto Sans JP subset standing
// in for what Google Fonts returns (built with pyftsubset from Noto Sans JP, OFL 1.1).
const JAKARTA = read(path.join(here, '../../../public/fonts/plus-jakarta-sans-700.ttf'));
const ADA = read(path.join(here, '../../../public/fonts/ada-symbol.ttf'));
const NOTO_JP_SUBSET = read(path.join(here, '__fixtures__/noto-sans-jp-subset.ttf'));

const bundled: OgFont[] = [
  { name: 'Plus Jakarta Sans', data: JAKARTA, weight: 700, style: 'normal' },
  { name: 'Ada', data: ADA, weight: 700, style: 'normal' },
];
const covered = new Set([...coveredCodepoints(JAKARTA), ...coveredCodepoints(ADA)]);

/** A fetcher that answers the Google Fonts CSS lookup and the font download with
    the fixture, so no test touches the network. Records the URLs it was asked for. */
function stubFetcher(font: ArrayBuffer = NOTO_JP_SUBSET): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://fonts.googleapis.com/')) {
      return new Response("@font-face { src: url(https://fonts.gstatic.com/l/font?kit=x) format('woff'); }");
    }
    return new Response(font);
  }) as typeof fetch & { urls: string[] };
  fetcher.urls = urls;
  return fetcher;
}

describe('fallbackRequests', () => {
  it('asks for nothing when the bundled font covers the text', () => {
    // Includes the ada sign, which rides on the bundled one-glyph face: every card
    // carries it, so it must never be what sends a card down the fallback path.
    expect(fallbackRequests('Cardano DRep - "Alice" 50% ₳1.2M', covered)).toEqual([]);
    // Latin-1 accents are in the shipped subset, so a German or French name is free.
    expect(fallbackRequests('Jörg Müller, Ané', covered)).toEqual([]);
  });

  it('asks for a Japanese face for kana, and pulls the ideographs along', () => {
    expect(fallbackRequests('忠実なテスト', covered)).toEqual([
      { family: 'Noto Sans JP', text: 'なステト実忠' },
    ]);
  });

  it('asks for the simplified Chinese face for bare ideographs', () => {
    expect(fallbackRequests('忠実', covered)).toEqual([{ family: 'Noto Sans SC', text: '実忠' }]);
  });

  it('asks for a Korean face for Hangul', () => {
    expect(fallbackRequests('한국', covered)).toEqual([{ family: 'Noto Sans KR', text: '국한' }]);
  });

  it('routes Cyrillic and Latin Extended to the general Noto Sans face', () => {
    expect(fallbackRequests('Дмитрий', covered)[0].family).toBe('Noto Sans');
    // Latin Extended-A is absent from the shipped subset, so these need it too.
    expect(fallbackRequests('Łukasz', covered)).toEqual([{ family: 'Noto Sans', text: 'Ł' }]);
  });

  it('requests each uncovered character once, in codepoint order', () => {
    expect(fallbackRequests('忠忠実忠', covered)).toEqual([{ family: 'Noto Sans SC', text: '実忠' }]);
  });

  it('caps the number of families at two', () => {
    expect(fallbackRequests('Łukasz 忠実 한국 עברית', covered).length).toBe(2);
  });
});

describe('loadFallbackFonts', () => {
  beforeEach(clearFallbackFontCache);

  it('returns nothing, and makes no request, for a Latin-only card', async () => {
    let calls = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return stubFetcher()(...args);
    }) as typeof fetch;
    expect(await loadFallbackFonts('<div>Alice</div>', bundled, counting)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('loads a face that covers the CJK characters in the card', async () => {
    const fonts = await loadFallbackFonts('<div>忠実</div>', bundled, stubFetcher());
    expect(fonts.length).toBe(1);
    const glyphs = coveredCodepoints(fonts[0].data);
    expect(glyphs.has('忠'.codePointAt(0) as number)).toBe(true);
    expect(glyphs.has('実'.codePointAt(0) as number)).toBe(true);
  });

  it('names the family and the characters in the lookup', async () => {
    const fetcher = stubFetcher();
    await loadFallbackFonts('<div>忠実</div>', bundled, fetcher);
    // The characters have to travel with the request even though a CJK family is
    // served whole: without them Google answers with a Latin-only slice of the
    // face, which draws the name as empty boxes.
    expect(fetcher.urls[0]).toBe(
      'https://fonts.googleapis.com/css?family=Noto%20Sans%20SC:700&text=%E5%AE%9F%E5%BF%A0',
    );
    expect(fetcher.urls[1]).toBe('https://fonts.gstatic.com/l/font?kit=x');
  });

  it('reuses a loaded CJK face for the next name instead of downloading it again', async () => {
    const fetcher = stubFetcher();
    await loadFallbackFonts('<div>忠実</div>', bundled, fetcher);
    await loadFallbackFonts('<div>中国</div>', bundled, fetcher);
    expect(fetcher.urls.length).toBe(2);
  });

  it('falls back to no extra font when the font service fails', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    expect(await loadFallbackFonts('<div>忠実</div>', bundled, failing)).toEqual([]);
    const throwing = (async () => {
      throw new Error('timed out');
    }) as typeof fetch;
    expect(await loadFallbackFonts('<div>忠実</div>', bundled, throwing)).toEqual([]);
  });
});

/** Renders one line of text through satori (the layout engine workers-og wraps)
    and returns the glyph outline data, which is empty when no loaded font can
    draw the text. */
async function glyphOutlines(text: string, fonts: OgFont[]): Promise<string> {
  // satori's own element shape, which is not the React element type its
  // signature names (workers-og feeds it parsed HTML the same way).
  const node = {
    type: 'div',
    props: {
      style: { display: 'flex', width: 600, height: 120, fontSize: 64, fontFamily: "'Plus Jakarta Sans'" },
      children: text,
    },
  } as unknown as Parameters<typeof satori>[0];
  const svg = await satori(node, { width: 600, height: 120, fonts });
  return [...svg.matchAll(/<path[^>]*\sd="([^"]*)"/g)].map((m) => m[1]).join('');
}

describe('rendering a CJK name', () => {
  beforeEach(clearFallbackFontCache);

  it('draws the name once the fallback face is loaded', async () => {
    // Without a face for the script the bundled fonts have no outlines to draw
    // and satori falls back to empty boxes, which is the blank gap on the card.
    const withoutFallback = await glyphOutlines('忠実', bundled);
    const fonts = [...bundled, ...(await loadFallbackFonts('忠実', bundled, stubFetcher()))];
    const withFallback = await glyphOutlines('忠実', fonts);
    expect(withFallback.length).toBeGreaterThan(0);
    expect(withFallback).not.toBe(withoutFallback);
    // The real glyphs are far more path data than two empty boxes.
    expect(withFallback.length).toBeGreaterThan(withoutFallback.length * 3);
  });
});
