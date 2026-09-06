// Layer 1 of the fact-check gate: every number, chart series, link and name in
// an edition must trace to its frozen pack snapshot, in the unit and precision
// the text shows. Runs in CI over every edition. It catches invented, stale and
// mislabeled numbers. A wrong statement about a right number is layer 2.
import type { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { chartSpecSchema } from './charts/index.js';
import { scaleFor } from './charts/schema.js';
import type { ReviewFrontmatter } from './schema.js';

export interface Finding {
  rule: string;
  message: string;
}
export interface Shown {
  value: number;
  unit: '' | 'M' | 'B' | '%';
  decimals: number;
  negative: boolean;
}

/** A chart spec after parsing: schema defaults such as `format` are filled in. */
type ParsedChartSpec = z.output<typeof chartSpecSchema>;

const UNIT_MULT: Record<Shown['unit'], number> = { '': 1, M: 1e6, B: 1e9, '%': 1 };

/** "₳120M" -> 120 M, "−232M" -> 232 M negative, "69.9%" -> 69.9 %, "4,321" -> 4321. */
export function parseShown(text: string): Shown | null {
  const m = /^(?:₳\s*)?([−-])?\s*(\d[\d,]*(?:\.\d+)?)\s*(M|B|%|million|billion)?$/i.exec(text.trim());
  if (!m) return null;
  const raw = m[2].replace(/,/g, '');
  const u = (m[3] ?? '').toLowerCase();
  const unit: Shown['unit'] =
    u === 'm' || u === 'million' ? 'M' : u === 'b' || u === 'billion' ? 'B' : u === '%' ? '%' : '';
  return { value: Number(raw), unit, decimals: (raw.split('.')[1] ?? '').length, negative: m[1] != null };
}

/** True when the candidate, expressed in the shown unit and rounded to the shown decimals, equals the shown number. Counts (no unit, no decimals) must be exact. */
export function shownMatches(shown: Shown, candidate: number): boolean {
  const signed = shown.negative ? -shown.value : shown.value;
  if (shown.unit === '' && shown.decimals === 0) return Number.isInteger(candidate) && candidate === signed;
  const scaled = candidate / UNIT_MULT[shown.unit];
  const f = 10 ** shown.decimals;
  return Math.round(scaled * f) / f === Math.round(signed * f) / f;
}

function walkPath(cur: unknown, parts: string[]): unknown {
  if (parts.length === 0) return cur;
  const [part, ...rest] = parts;
  // "[]" maps the rest of the path over every element, "[2]" reads one element
  if (part === '[]') return Array.isArray(cur) ? cur.map((x) => walkPath(x, rest)) : undefined;
  const idx = /^\[(\d+)\]$/.exec(part);
  if (idx) return Array.isArray(cur) ? walkPath(cur[Number(idx[1])], rest) : undefined;
  if (cur == null || typeof cur !== 'object') return undefined;
  return walkPath((cur as Record<string, unknown>)[part], rest);
}

function resolvePath(obj: unknown, path: string): unknown {
  // "a.b[0].c" and "a.b[].c" (every element of b, returns an array)
  const parts = path.split(/\.(?![^[]*\])/).flatMap((p) => p.split(/(\[\d*\])/).filter(Boolean));
  return walkPath(obj, parts);
}

function collectNumbers(v: unknown, out: Set<number>): void {
  if (typeof v === 'number' && Number.isFinite(v)) out.add(v);
  else if (Array.isArray(v)) {
    out.add(v.length);
    for (const x of v) collectNumbers(x, out);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) collectNumbers(x, out);
}

function collectStrings(v: unknown, keys: RegExp, out: Set<string>): void {
  if (Array.isArray(v)) for (const x of v) collectStrings(x, keys, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if (keys.test(k) && typeof x === 'string' && x) out.add(x);
      else collectStrings(x, keys, out);
    }
}

/** Capitalized only because they open a sentence. Any other word at a sentence start is checked like the rest. */
const SENTENCE_STARTERS = new Set(['The', 'A', 'An', 'In', 'By', 'On', 'At', 'As', 'Of', 'And', 'For', 'With', 'That', 'This', 'These', 'Those', 'It', 'Its', 'He', 'She', 'They', 'We', 'But', 'So', 'If', 'When', 'While', 'After', 'Before', 'Since', 'Until', 'Both', 'Neither', 'Every', 'Each', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Half', 'Most', 'Some', 'None', 'Not', 'No', 'Yes', 'What', 'Where', 'Why', 'How', 'Whatever', 'Part', 'Compared', 'Read', 'Only', 'Also', 'Still', 'Then', 'There', 'Here', 'Nothing', 'Everything', 'Nobody', 'Whether', 'Unless', 'Without', 'Behind', 'Between', 'Under', 'Over', 'Across', 'Against', 'Steps', 'Rewards']);

const GOVERNANCE_TERMS = new Set([
  'Cardano', 'DRep', 'DReps', 'SPO', 'SPOs', 'Constitutional Committee', 'Constitution', 'Governance Review', 'DRepTalk',
  'Yes', 'No', 'Abstain', 'Epoch', 'Epochs', 'Mainnet', 'Koios', 'Plutus', 'Treasury', 'Intersect',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Info', 'Parameter', 'Hard', 'Fork', 'Protocol', 'Version', 'Update', 'Committee', 'Chang', 'Plomin', 'Van Rossem', 'Interim',
]);

export function factCheckEdition(input: { frontmatter: ReviewFrontmatter; body: string; pack: unknown }): Finding[] {
  const out: Finding[] = [];
  const { frontmatter: fm, body, pack } = input;

  // 3. derived values first: only entries that recompute correctly become addressable as derived[i].value
  const verifiedDerived: Array<{ value: number } | null> = fm.derived.map((d) => {
    const parts = d.from.map((p) => resolvePath(pack, p));
    if (parts.some((p) => typeof p !== 'number')) {
      out.push({ rule: 'derived-wrong', message: `derived ${d.value}: a source is not numeric` });
      return null;
    }
    const nums = parts as number[];
    const got = d.op === 'sum' ? nums.reduce((a, b) => a + b, 0) : nums.slice(1).reduce((a, b) => a - b, nums[0]);
    if (Math.abs(got - d.value) > 1e-6 * Math.max(1, Math.abs(got))) {
      out.push({ rule: 'derived-wrong', message: `derived ${d.value} but ${d.op} of ${d.from.join(', ')} is ${got}` });
      return null;
    }
    return { value: d.value };
  });
  // Source paths resolve against the pack plus the verified derived values under the reserved key "derived".
  const scope = { ...(pack as Record<string, unknown>), derived: verifiedDerived };

  // Candidate numbers: every number and array length in the pack, the verified derived values, and epochs around the window.
  const candidates = new Set<number>();
  collectNumbers(pack, candidates);
  for (const d of verifiedDerived) if (d) candidates.add(d.value);
  for (let e = fm.epochFrom - 30; e <= fm.epochTo + 30; e++) candidates.add(e);
  const known = (shown: Shown) => [...candidates].some((c) => shownMatches(shown, c));

  // 1. fact tiles
  fm.facts.forEach((f, i) => {
    const shown = parseShown(f.value);
    const src = resolvePath(scope, f.source);
    const ok = shown ? typeof src === 'number' && shownMatches(shown, src) : String(src) === f.value;
    if (!ok) out.push({ rule: 'fact-source-mismatch', message: `fact ${i + 1} "${f.value}" does not equal ${f.source} (${String(src)})` });
  });

  // 4. chart blocks, then strip them from the prose
  const chartRe = /```chart\n([\s\S]*?)```/g;
  let chartIndex = 0;
  for (const m of body.matchAll(chartRe)) {
    chartIndex++;
    let raw: unknown;
    try {
      raw = parseYaml(m[1]);
    } catch (e) {
      out.push({ rule: 'chart-invalid', message: `chart ${chartIndex}: invalid YAML (${(e as Error).message})` });
      continue;
    }
    const parsed = chartSpecSchema.safeParse(raw);
    if (!parsed.success) {
      out.push({ rule: 'chart-invalid', message: `chart ${chartIndex}: ${parsed.error.message}` });
      continue;
    }
    const spec: ParsedChartSpec = parsed.data;
    // epoch-indexed charts: the epoch source must yield exactly the epochs the chart shows
    if (spec.type === 'line' || spec.type === 'bars' || spec.type === 'stacked') {
      const shownEpochs = spec.type === 'line' ? spec.values.map((_, i) => spec.epochFrom + i) : spec.epochs;
      const rawEpochs = resolvePath(scope, spec.epochSource);
      const srcEpochs = Array.isArray(rawEpochs) ? rawEpochs : [];
      if (srcEpochs.length !== shownEpochs.length || shownEpochs.some((e, i) => srcEpochs[i] !== e)) {
        out.push({ rule: 'chart-source-mismatch', message: `chart ${chartIndex}: shown epochs ${shownEpochs[0]} to ${shownEpochs.at(-1)} do not match ${spec.epochSource} (epoch ${srcEpochs[0]} to ${srcEpochs.at(-1)})` });
      }
    }
    const series: number[][] =
      spec.type === 'line' ? [spec.values.map((v) => v ?? Number.NaN)]
      : spec.type === 'lines' ? spec.series.map((x) => x.values)
      : spec.type === 'stacked' ? [spec.yes, spec.no, spec.abstain]
      : spec.type === 'bars' ? [spec.values]
      : spec.type === 'hbars' ? spec.rows.map((r) => [r.value])
      : spec.groups.map((g) => [g.count]);
    if (series.length !== spec.sources.length) {
      out.push({ rule: 'chart-source-mismatch', message: `chart ${chartIndex}: ${series.length} series but ${spec.sources.length} sources` });
      continue;
    }
    series.forEach((vals, k) => {
      const rawSeries = resolvePath(scope, spec.sources[k]);
      const src = (Array.isArray(rawSeries) ? rawSeries : [rawSeries]).map((x) => (typeof x === 'number' ? x / scaleFor(spec.format) : Number.NaN));
      vals.forEach((v, i) => {
        if (Number.isNaN(v)) return; // a gap in the chart is not a claim
        const decimals = (String(v).split('.')[1] ?? '').length;
        const f = 10 ** decimals;
        const s = src[i];
        if (s == null || Number.isNaN(s) || Math.round(s * f) / f !== v) out.push({ rule: 'chart-source-mismatch', message: `chart ${chartIndex} series ${k + 1} value ${i + 1} (${v}) is not ${spec.sources[k]}[${i}] (${s})` });
      });
    });
  }
  const prose = body.replace(chartRe, '');

  // 5. links
  const ids = new Set<string>();
  const titlesById = new Map<string, string>();
  const aliasesById = new Map<string, string[]>();
  for (const group of ['events', 'closingAtBoundary', 'open', 'comparisons']) {
    for (const a of (resolvePath(pack, `actions.${group}`) as Array<{ id: string; title: string }> | undefined) ?? []) {
      ids.add(a.id);
      titlesById.set(a.id, a.title);
    }
  }
  for (const r of [...fm.alsoDecided, ...fm.openActions]) aliasesById.set(r.id, r.aliases);
  const drepNames = new Map<string, string>();
  for (const d of (resolvePath(pack, 'topDreps') as Array<{ drepId: string; name: string | null }> | undefined) ?? []) if (d.name) drepNames.set(d.drepId, d.name);
  for (const list of Object.values((resolvePath(pack, 'topVoters') as Record<string, Array<{ drepId: string; name: string | null }>> | undefined) ?? {})) for (const v of list) if (v.name) drepNames.set(v.drepId, v.name);
  const verifiedLinkTexts = new Set<string>();
  for (const m of prose.matchAll(/\[([^\]]+)\]\(\/(ga|dreps)\/([^)]+?)\/\)/g)) {
    const [, text, kind, rawId] = m;
    const id = decodeURIComponent(rawId);
    let ok = false;
    if (kind === 'ga') {
      if (!ids.has(id)) out.push({ rule: 'link-not-in-pack', message: `link to unknown action ${id}` });
      else if (text !== titlesById.get(id) && !(aliasesById.get(id) ?? []).includes(text)) out.push({ rule: 'link-not-in-pack', message: `link text "${text}" is neither the title nor an alias of ${id}` });
      else ok = true;
    } else if (!drepNames.has(id)) out.push({ rule: 'link-not-in-pack', message: `link to unknown DRep ${id}` });
    else if (text !== drepNames.get(id)) out.push({ rule: 'link-not-in-pack', message: `link text "${text}" is not the pack name of ${id}` });
    else ok = true;
    if (ok) verifiedLinkTexts.add(text);
  }

  // 2. numbers in prose. Verified links are removed whole first (a year inside a
  // verified title is not a claim), unverified links keep their text.
  const plain = prose.replace(/\[([^\]]+)\]\([^)]*\)/g, (_, text: string) => (verifiedLinkTexts.has(text) ? '' : text));
  for (const m of plain.matchAll(/(?:₳\s*)?[−-]?\d[\d,]*(?:\.\d+)?\s*(?:%|M\b|B\b|million\b|billion\b)?/g)) {
    const shown = parseShown(m[0]);
    if (shown && !known(shown)) out.push({ rule: 'number-not-in-pack', message: `"${m[0].trim()}" is not in the pack or derived list` });
  }

  // 6. names. Every capitalized run, sentence starts included, must decompose
  // whole word by whole word into pack names, pack titles, verified link texts
  // or governance terms. No substring matches: "Evil Yoroi Wallet" is not
  // "Yoroi Wallet". A heuristic over free prose: it finds unknown proper names,
  // it does not prove a known name is used correctly (that is layer 2).
  const knownRuns = new Set<string>([...GOVERNANCE_TERMS, ...verifiedLinkTexts]);
  collectStrings(pack, /^(name|title)$/, knownRuns);
  const knownWordLists = [...knownRuns].map((n) => n.split(/\s+/));
  const sentences = plain.replace(/^#+ .*$/gm, '').split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).map((w) => w.replace(/[.,:;!?()"]+$/, '').replace(/^[("]+/, ''));
    for (let i = 0; i < words.length; i++) {
      if (!/^[A-Z][\w₳'’.-]*$/.test(words[i])) continue;
      if (i === 0 && SENTENCE_STARTERS.has(words[0])) continue;
      let j = i;
      while (j + 1 < words.length && /^[A-Z][\w'’.-]*$/.test(words[j + 1])) j++;
      // greedy whole-word decomposition of words[i..j] into known runs
      let k = i;
      let failed = false;
      while (k <= j) {
        const hit = knownWordLists.filter((wl) => wl.every((w, off) => words[k + off] === w)).sort((a, b) => b.length - a.length)[0];
        if (!hit) {
          failed = true;
          break;
        }
        k += hit.length;
      }
      if (failed) out.push({ rule: 'name-not-in-pack', message: `"${words.slice(i, j + 1).join(' ')}" is not a name or title in the pack` });
      i = j;
    }
  }

  // 7. closing actions: paragraphs that mention them
  const closing = (resolvePath(pack, 'actions.closingAtBoundary') as Array<{ id: string; title: string }> | undefined) ?? [];
  for (const a of closing) {
    const needles = [a.id, a.title.slice(0, 24), ...(aliasesById.get(a.id) ?? [])];
    for (const para of prose.split(/\n\s*\n/)) {
      if (!needles.some((n) => para.includes(n))) continue;
      if (/\b(was|were|got|is now|has been|have been) (ratified|enacted|expired|dropped|rejected|approved)\b/i.test(para)) out.push({ rule: 'closing-outcome-stated', message: `"${a.title}" closes at the boundary but the text states an outcome` });
      if (!/\b(as of|at close|as this edition)\b/i.test(para)) out.push({ rule: 'closing-without-as-of', message: `"${a.title}" is discussed without an "as of" or "at close" marker` });
    }
  }

  // 8. phrasing
  if (/[—–]|&mdash;|&ndash;/.test(prose)) out.push({ rule: 'forbidden-phrasing', message: 'typographic dash' });
  if (/;\s/.test(prose)) out.push({ rule: 'forbidden-phrasing', message: 'semicolon in prose' });
  if (/\bADA\b/.test(prose)) out.push({ rule: 'forbidden-phrasing', message: 'uppercase ADA' });
  if (/\blands? (on|exactly|where)\b/i.test(prose)) out.push({ rule: 'forbidden-phrasing', message: '"lands" phrasing' });
  return out;
}
