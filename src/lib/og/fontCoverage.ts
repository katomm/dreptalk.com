// Which codepoints a font can actually draw. The OG cards ship a Latin-only
// Plus Jakarta Sans subset (229 codepoints, roughly ASCII plus Latin-1), so any
// name outside that set renders as an empty gap unless a fallback font is loaded
// for it. Reading the coverage off the font itself keeps that gate honest: swap
// the bundled subset and the fallback trigger follows, no constant to update.
//
// Only the cmap table is read, and only the two subtable formats that matter for
// TrueType/OpenType fonts on the web: format 4 (Basic Multilingual Plane) and
// format 12 (full range, used by fonts with astral glyphs).

/** Offset of a table in the sfnt directory, or 0 when the font lacks it. */
function tableOffset(view: DataView, bytes: Uint8Array, tag: string): number {
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const entry = 12 + i * 16;
    const name = String.fromCharCode(bytes[entry], bytes[entry + 1], bytes[entry + 2], bytes[entry + 3]);
    if (name === tag) return view.getUint32(entry + 8);
  }
  return 0;
}

/** Picks the widest Unicode cmap subtable: a full-range one when present, else BMP. */
function unicodeSubtable(view: DataView, cmap: number): number {
  const count = view.getUint16(cmap + 2);
  let best = 0;
  let bestFormat = -1;
  for (let i = 0; i < count; i++) {
    const record = cmap + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    // Unicode (0, any) and Windows Unicode BMP/full (3, 1) and (3, 10).
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = view.getUint16(offset);
    if (format !== 4 && format !== 12) continue;
    // Format 12 wins over format 4: it is a superset of the same font's BMP map.
    if (format > bestFormat) {
      bestFormat = format;
      best = offset;
    }
  }
  return best;
}

function readFormat4(view: DataView, sub: number, out: Set<number>): void {
  const segCountX2 = view.getUint16(sub + 6);
  const endCodes = sub + 14;
  const startCodes = endCodes + segCountX2 + 2;
  const idDeltas = startCodes + segCountX2;
  const idRanges = idDeltas + segCountX2;
  for (let s = 0; s < segCountX2 / 2; s++) {
    const end = view.getUint16(endCodes + s * 2);
    const start = view.getUint16(startCodes + s * 2);
    // The final 0xffff segment is padding required by the format.
    if (start === 0xffff) continue;
    const delta = view.getInt16(idDeltas + s * 2);
    const rangeOffset = view.getUint16(idRanges + s * 2);
    for (let code = start; code <= end; code++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        // The range offset is a byte distance from its own slot into glyphIdArray.
        glyph = view.getUint16(idRanges + s * 2 + rangeOffset + (code - start) * 2);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(code);
    }
  }
}

function readFormat12(view: DataView, sub: number, out: Set<number>): void {
  const groups = view.getUint32(sub + 12);
  for (let g = 0; g < groups; g++) {
    const group = sub + 16 + g * 12;
    const start = view.getUint32(group);
    const end = view.getUint32(group + 4);
    for (let code = start; code <= end; code++) out.add(code);
  }
}

/**
 * The set of codepoints a font file can draw. Returns an empty set for anything
 * that cannot be parsed (a compressed woff, a truncated file), which makes the
 * caller treat the font as covering nothing: a needless fallback fetch at worst,
 * never a thrown request.
 */
export function coveredCodepoints(data: ArrayBuffer): Set<number> {
  const covered = new Set<number>();
  try {
    const view = new DataView(data);
    const bytes = new Uint8Array(data);
    const cmap = tableOffset(view, bytes, 'cmap');
    if (!cmap) return covered;
    const sub = unicodeSubtable(view, cmap);
    if (!sub) return covered;
    if (view.getUint16(sub) === 12) readFormat12(view, sub, covered);
    else readFormat4(view, sub, covered);
  } catch {
    return new Set<number>();
  }
  return covered;
}

// The bundled fonts are fetched once per isolate and reused, so their coverage is
// memoised on the buffer itself: the common Latin-only card then pays one Set
// lookup per character and no parsing at all after the first render.
const memo = new WeakMap<ArrayBuffer, Set<number>>();

/** coveredCodepoints, memoised per font buffer. */
export function cachedCoveredCodepoints(data: ArrayBuffer): Set<number> {
  let covered = memo.get(data);
  if (!covered) {
    covered = coveredCodepoints(data);
    memo.set(data, covered);
  }
  return covered;
}
