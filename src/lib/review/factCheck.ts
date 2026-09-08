// Layer 1 of the fact-check gate: every number, chart series, link and name in
// an edition must trace to its frozen pack snapshot, in the unit and precision
// the text shows. Runs in CI over every edition. It catches invented, stale and
// mislabeled numbers. A wrong statement about a right number is layer 2.
//
// The scan covers the body and every prose field around it (title, standfirst,
// fact labels, the social figure's label, correction notes and the text inside
// chart blocks), so there is no field an unbacked number or name can hide in.
import type { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { chartSpecSchema } from './charts/index.js';
import { scaleFor } from './charts/schema.js';
import { govActionIdFromPath } from './links.js';
import type { ActionRow, ReviewFrontmatter } from './schema.js';

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

/** One piece of checked prose and the name a finding reports it under. */
interface Segment {
  label: string;
  text: string;
}

/** The shape the fact check reads off a pack action. Everything is optional so a hand-written fixture pack stays legal. */
interface PackActionShape {
  id: string;
  title?: string;
  status?: string;
  open?: boolean;
  expiryEpoch?: number | null;
  eventsInWindow?: Array<{ epoch: number }>;
  tally?: { drep?: { yesPct?: number | null } };
}

const ACTION_GROUPS = ['events', 'closingAtBoundary', 'open', 'comparisons'] as const;

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

/**
 * Outcome words. In a paragraph about an action that is still open at the
 * window's boundary the writer describes tallies and bars, never outcomes, so
 * any of these words is a finding no matter which auxiliary carries it.
 */
const OUTCOME_WORDS = /\b(ratified|enacted|expired|dropped|rejected|approved|passed|pass|failed|fail|carried|adopted|defeated|succeeded)\b/i;

/** Typographic dashes and the HTML entities that render as one. */
const DASHES = /[—–―]|&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;/;
const LANDS = /\bland(s|ed|ing)?\s+(on|there|where|exactly|in|at)\b/i;
/** A number-shaped run in prose, with the unit it is shown in. Case-insensitive: "4.3m" claims the same as "4.3M". */
const NUMBER_RUN = /(?:₳\s*)?[−-]?\d[\d,]*(?:\.\d+)?\s*(?:%|M\b|B\b|million\b|billion\b)?/gi;
/** A markdown link, used both to verify links and to drop verified spans from the scan. */
const LINK_RE = /\[([^\]]+)\]\(\/(ga|dreps)\/([^)]+?)\/\)/g;
/** A ```chart fence, trailing spaces on the opening line included, matching what the renderer accepts. */
const CHART_RE = /```chart[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Prose as the number scanner sees it: an ISO date is a date, not a claim, and
 * an epoch range ("650-652") is two epochs rather than one negative number.
 */
function scannable(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/\b(\d{3})\s?(?:to|-)\s?(\d{3})\b/g, '$1 $2');
}

/** Markdown heading marks carry no meaning for the scans, the words after them do. */
function stripHeadingMarks(text: string): string {
  return text.replace(/^#+[ \t]*/gm, '');
}

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

  // 1. fact tiles and the social figure, which is a fact tile on a card
  const checkValue = (label: string, value: string, source: string) => {
    const shown = parseShown(value);
    const src = resolvePath(scope, source);
    const ok = shown ? typeof src === 'number' && shownMatches(shown, src) : String(src) === value;
    if (!ok) out.push({ rule: 'fact-source-mismatch', message: `${label} "${value}" does not equal ${source} (${String(src)})` });
  };
  for (const [i, f] of fm.facts.entries()) checkValue(`fact ${i + 1}`, f.value, f.source);
  checkValue('ogFigure', fm.ogFigure.value, fm.ogFigure.source);

  // Everything the number, name and phrasing scans run over. Body paragraphs are
  // added after the links are verified, the frontmatter and chart prose here.
  const segments: Segment[] = [
    { label: 'title', text: fm.title },
    { label: 'standfirst', text: fm.standfirst },
    ...(fm.listTitle ? [{ label: 'listTitle', text: fm.listTitle }] : []),
    ...(fm.teaser ? [{ label: 'teaser', text: fm.teaser }] : []),
    { label: 'ogFigure label', text: fm.ogFigure.label },
    ...fm.facts.map((f, i) => ({ label: `fact ${i + 1} label`, text: f.label })),
    ...fm.corrections.map((c, i) => ({ label: `correction ${i + 1} note`, text: c.note })),
  ];

  // 4. chart blocks, then strip them from the prose
  let chartIndex = 0;
  for (const m of body.matchAll(CHART_RE)) {
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
    // The words inside a chart are prose too, so they face the same three scans.
    const n = chartIndex;
    segments.push({ label: `chart ${n} title`, text: spec.title });
    if (spec.subtitle) segments.push({ label: `chart ${n} subtitle`, text: spec.subtitle });
    if (spec.caption) segments.push({ label: `chart ${n} caption`, text: spec.caption });
    if (spec.type === 'line') for (const [i, mk] of spec.markers.entries()) segments.push({ label: `chart ${n} marker ${i + 1} label`, text: mk.label });
    if (spec.type === 'hbars') for (const [i, r] of spec.rows.entries()) segments.push({ label: `chart ${n} row ${i + 1} label`, text: r.label });
    if (spec.type === 'seats') for (const [i, g] of spec.groups.entries()) segments.push({ label: `chart ${n} group ${i + 1} label`, text: g.label });
    if (spec.type === 'lines') for (const [i, s] of spec.series.entries()) segments.push({ label: `chart ${n} series ${i + 1} name`, text: s.name });
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
  const prose = body.replace(CHART_RE, '');

  // 5. links
  const ids = new Set<string>();
  const titlesById = new Map<string, string>();
  const aliasesById = new Map<string, string[]>();
  const packById = new Map<string, { row: PackActionShape; group: string }>();
  for (const group of ACTION_GROUPS) {
    for (const a of (resolvePath(pack, `actions.${group}`) as PackActionShape[] | undefined) ?? []) {
      ids.add(a.id);
      packById.set(a.id, { row: a, group });
      if (a.title) titlesById.set(a.id, a.title);
    }
  }
  for (const r of [...fm.alsoDecided, ...fm.openActions]) aliasesById.set(r.id, r.aliases);
  const drepNames = new Map<string, string>();
  for (const d of (resolvePath(pack, 'topDreps') as Array<{ drepId: string; name: string | null }> | undefined) ?? []) if (d.name) drepNames.set(d.drepId, d.name);
  for (const list of Object.values((resolvePath(pack, 'topVoters') as Record<string, Array<{ drepId: string; name: string | null }>> | undefined) ?? {})) for (const v of list) if (v.name) drepNames.set(v.drepId, v.name);
  // Only a link text that IS the pack title or the pack name earns the two
  // exemptions below (dropped from the number scan, added to the name
  // whitelist). An alias is the author's own wording: the link itself is
  // verified, but the words stay in the scanned text like any other prose.
  const verifiedLinkTexts = new Set<string>();
  const linkedActionIds = new Set<string>();
  for (const m of prose.matchAll(LINK_RE)) {
    const [, text, kind, rawId] = m;
    const decoded = decodeURIComponent(rawId);
    // A /ga/ path is the CIP-129 hex form govActionHref emits (the resolver
    // never decodes '%23' back to '#'), so it is normalized back to the pack's
    // "<hash>#<index>" id before the lookup below. The '%23' form still works:
    // it decodes straight to that id, and govActionIdFromPath returns null for
    // it, so the fallback keeps it as is.
    const id = kind === 'ga' ? (govActionIdFromPath(decoded) ?? decoded) : decoded;
    let canonical = false;
    if (kind === 'ga') {
      linkedActionIds.add(id);
      if (!ids.has(id)) out.push({ rule: 'link-not-in-pack', message: `link to unknown action ${id}` });
      else if (text !== titlesById.get(id) && !(aliasesById.get(id) ?? []).includes(text)) out.push({ rule: 'link-not-in-pack', message: `link text "${text}" is neither the title nor an alias of ${id}` });
      else canonical = text === titlesById.get(id);
    } else if (!drepNames.has(id)) out.push({ rule: 'link-not-in-pack', message: `link to unknown DRep ${id}` });
    else if (text !== drepNames.get(id)) out.push({ rule: 'link-not-in-pack', message: `link text "${text}" is not the pack name of ${id}` });
    else canonical = true;
    if (canonical) verifiedLinkTexts.add(text);
  }

  // Body paragraphs, headings included. A verified link span is removed whole
  // (a year inside a verified title is not a claim), every other link keeps its
  // text. Numbering is over the paragraphs of the body, charts already removed.
  const paragraphs = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  paragraphs.forEach((p, i) => {
    segments.push({ label: `paragraph ${i + 1}`, text: p.replace(/\[([^\]]+)\]\([^)]*\)/g, (_, text: string) => (verifiedLinkTexts.has(text) ? '' : text)) });
  });

  // 2. numbers, in every scanned segment
  for (const seg of segments) {
    for (const m of scannable(stripHeadingMarks(seg.text)).matchAll(NUMBER_RUN)) {
      const shown = parseShown(m[0]);
      if (shown && !known(shown)) out.push({ rule: 'number-not-in-pack', message: `"${m[0].trim()}" is not in the pack or derived list (${seg.label})` });
    }
  }

  // 6. names. Every capitalized run, sentence starts and headings included, must
  // decompose whole word by whole word into pack names, pack titles, verified
  // link texts or governance terms. No substring matches: "Evil Yoroi Wallet" is
  // not "Yoroi Wallet". A heuristic over free prose: it finds unknown proper
  // names, it does not prove a known name is used correctly (that is layer 2).
  // A word an alias takes from its own action's title is a name the article may
  // then use on its own ("Scalus" out of the full proposal title), in prose and
  // in a chart label, which a bare title word could not be. The word has to be
  // in that title: an alias is a short form, never a licence to introduce a
  // name the record does not carry. Whether the short form is used for the
  // right action stays layer 2's job, like every other known name.
  const knownRuns = new Set<string>([...GOVERNANCE_TERMS, ...verifiedLinkTexts]);
  const titleWord = (w: string) => w.replace(/[.,:;!?()"“”]+$/, '').replace(/^[("“]+/, '').replace(/[’']s$/, '');
  for (const [id, list] of aliasesById) {
    const words = new Set((titlesById.get(id) ?? '').split(/\s+/).map(titleWord).filter(Boolean));
    for (const alias of list) for (const w of alias.split(/\s+/).map(titleWord)) if (words.has(w)) knownRuns.add(w);
  }
  collectStrings(pack, /^(name|title)$/, knownRuns);
  const knownWordLists = [...knownRuns].map((n) => n.split(/\s+/));
  for (const seg of segments) {
    // A heading loses its "#" marks and then opens a sentence like any line.
    const sentences = stripHeadingMarks(seg.text).split(/(?<=[.!?])\s+|\n+/);
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
        if (failed) out.push({ rule: 'name-not-in-pack', message: `"${words.slice(i, j + 1).join(' ')}" is not a name or title in the pack (${seg.label})` });
        i = j;
      }
    }
  }

  // 7. closing actions. The needles are a heuristic over free prose: an id, the
  // title stem or a declared alias is how a paragraph about the action is found,
  // so an action written around all three is only caught by rule 10 below.
  const closing = (resolvePath(pack, 'actions.closingAtBoundary') as PackActionShape[] | undefined) ?? [];
  for (const a of closing) {
    const title = a.title ?? '';
    const needles = [a.id, title.slice(0, 24), ...(aliasesById.get(a.id) ?? [])].filter(Boolean);
    paragraphs.forEach((para, i) => {
      if (!needles.some((n) => para.includes(n))) return;
      if (OUTCOME_WORDS.test(para)) out.push({ rule: 'closing-outcome-stated', message: `"${title}" closes at the boundary but the text states an outcome (paragraph ${i + 1})` });
      if (!/\b(as of|at close|as this edition)\b/i.test(para)) out.push({ rule: 'closing-without-as-of', message: `"${title}" is discussed without an "as of" or "at close" marker (paragraph ${i + 1})` });
    });
  }

  // 8. phrasing, reported once per segment and rule so a finding names its place
  for (const seg of segments) {
    if (DASHES.test(seg.text)) out.push({ rule: 'forbidden-phrasing', message: `typographic dash (${seg.label})` });
    if (/;\s/.test(seg.text)) out.push({ rule: 'forbidden-phrasing', message: `semicolon in prose (${seg.label})` });
    if (/\bADA\b/.test(seg.text)) out.push({ rule: 'forbidden-phrasing', message: `uppercase ADA (${seg.label})` });
    if (LANDS.test(seg.text)) out.push({ rule: 'forbidden-phrasing', message: `"lands" phrasing (${seg.label})` });
  }

  // 9. the action rows under the article must restate the pack, not a memory of it
  const checkRow = (list: string, i: number, r: ActionRow) => {
    const at = `${list} row ${i + 1}`;
    const hit = packById.get(r.id);
    if (!hit) {
      out.push({ rule: 'action-row-mismatch', message: `${at}: ${r.id} is not an action in the pack` });
      return;
    }
    const p = hit.row;
    if (r.title !== p.title) out.push({ rule: 'action-row-mismatch', message: `${at}: title "${r.title}" is not the pack title "${p.title}"` });
    // An action the pack still lists as running has no outcome yet, whatever its status column says.
    const stillOpen = hit.group === 'closingAtBoundary' || hit.group === 'open' || p.open === true;
    if (stillOpen && r.outcome !== 'open') out.push({ rule: 'action-row-mismatch', message: `${at}: outcome "${r.outcome}" but the pack still lists the action as running` });
    if (!stillOpen && r.outcome !== p.status) out.push({ rule: 'action-row-mismatch', message: `${at}: outcome "${r.outcome}" is not the pack status "${p.status}"` });
    // An open row is rendered as a voting close ("undecided at the close of
    // epoch N", "voting ends at the start of epoch N"), so its epoch is the
    // pack's expiry epoch and nothing else. An event epoch inside the window
    // would print as a close it is not.
    if (r.outcome === 'open') {
      if (r.epoch !== p.expiryEpoch) out.push({ rule: 'action-row-mismatch', message: `${at}: epoch ${r.epoch} is not the pack expiry epoch (${String(p.expiryEpoch ?? 'none')})` });
    } else {
      const epochs = (p.eventsInWindow ?? []).map((e) => e.epoch);
      if (!epochs.includes(r.epoch)) out.push({ rule: 'action-row-mismatch', message: `${at}: epoch ${r.epoch} is not an event epoch of the pack row (${epochs.join(', ') || 'none'})` });
    }
    const packPct = p.tally?.drep?.yesPct ?? null;
    const rowPct = r.drepYesPct ?? null;
    if (rowPct !== packPct) out.push({ rule: 'action-row-mismatch', message: `${at}: drepYesPct ${String(rowPct)} is not the pack tally ${String(packPct)}` });
  };
  for (const [i, r] of fm.alsoDecided.entries()) checkRow('alsoDecided', i, r);
  for (const [i, r] of fm.openActions.entries()) checkRow('openActions', i, r);

  // 10. an action closing at the boundary has to be linked, not merely alluded
  // to. The link is the needle rule 7 searches for, so a closing action the body
  // never links is a closing action the "as of" and outcome checks cannot see.
  // Rows with outcome "open" live in either list, so both are searched: an
  // undecided action listed under "Also decided" needs the link just as much.
  const closingIds = new Set(closing.map((a) => a.id));
  for (const r of [...fm.openActions, ...fm.alsoDecided.filter((a) => a.outcome === 'open')]) {
    if (closingIds.has(r.id) && !linkedActionIds.has(r.id)) {
      out.push({ rule: 'closing-not-linked', message: `"${r.title}" closes at the boundary but the body never links /ga/${r.id}/` });
    }
  }
  return out;
}
