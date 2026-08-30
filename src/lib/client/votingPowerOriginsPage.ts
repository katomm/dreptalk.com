// Client-side fetch and render for /voting-power-origins/. Bundled by Astro as a
// real module (not is:inline), so it needs no CSP hash. All copy is inserted via
// textContent/createElement, the only innerHTML is our own identiconSvg output.
//
// Fan geometry mirrors the approved mockup: a 960x460 viewBox, source stubs
// stacked on the left with a gap between them, cubic-bezier ribbons converging
// on a single contiguous "You" node on the right. Colors are source TYPES, not
// identities: three individual blue shades for the top DReps, a fourth shared
// shade for every DRep beyond that (whether merged into "Other DReps" in the
// fan or listed on its own row in the table).
import type { ProvenancePayload, ProvenanceSource } from '../delegation/provenance';
import { drepPath } from '../dreps/profile';
import { formatAdaCompact } from '../format/ada';
import { identiconSvg } from '../identity/identicon';

const FAN_TOP = 5;
const SVG_NS = 'http://www.w3.org/2000/svg';

const TYPE_LABELS: Record<string, string> = {
  new: 'New delegators',
  abstain: 'From always-abstain',
  no_confidence: 'From no confidence',
  unknown: 'Unknown origin',
};

// Fan/table layout constants, matching the approved mockup pixel for pixel.
// The viewBox width is fixed in the markup (0 0 960 460); only the height is
// needed here to center the stubs and the You node vertically.
const VIEW_H = 460;
const X0 = 288; // left edge of the ribbons (right edge of the source stubs)
const X1 = 758; // right edge of the ribbons (left edge of the You node)
const XM = (X0 + X1) / 2;
const STUB_X = X0 - 9;
const STUB_W = 9;
const NODE_W = 10;
const BAND_GAP = 14;
const MIN_THICKNESS = 8;
const TARGET_TOTAL_THICKNESS = 336;
const THIN_THRESHOLD = 24;
const STUB_LABEL_X = X0 - 20;
const YOU_LABEL_X = X1 + NODE_W + 12;

const API_URL = '/api/drep/voting-power-origins';

function ada(amount: string): string {
  return formatAdaCompact(amount) ?? '0 ₳';
}

function truncateId(id: string, len = 16): string {
  return id.length > len ? `${id.slice(0, len)}...` : id;
}

// Node.appendChild in a loop rather than Element.append(...nodes): the
// Cloudflare Workers ambient types (referenced globally in src/env.d.ts for
// the HTMLRewriter API) redeclare a global `Element` with its own single-arg
// `append(content, options?)`, which shadows DOM's variadic ParentNode.append
// for every .ts file in the project, this module included.
function appendAll(parent: Node, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

/** Display label: the DRep's on-chain name, else the type label, else a truncated id. */
function sourceLabel(s: ProvenanceSource): string {
  if (s.name) return s.name;
  if (s.type !== 'drep') return TYPE_LABELS[s.type] ?? s.type;
  return truncateId(s.drepId ?? '');
}

/**
 * Assigns the three individual DRep color slots to the first three distinct
 * DReps by amount (the payload is already sorted descending). Every DRep
 * beyond that shares the fourth, merged shade, regardless of whether it ends
 * up as its own fan stream or folded into "Other DReps".
 */
function assignDrepColorIndices(sources: ProvenanceSource[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of sources) {
    if (s.type !== 'drep' || !s.drepId) continue;
    if (map.size >= 3) break;
    if (!map.has(s.drepId)) map.set(s.drepId, map.size);
  }
  return map;
}

function colorKeyFor(s: ProvenanceSource, drepColor: Map<string, number>): string {
  if (s.type === 'drep') {
    const idx = s.drepId ? drepColor.get(s.drepId) : undefined;
    return idx === undefined ? 'drep-3' : `drep-${idx}`;
  }
  // no_confidence has no dedicated swatch in the approved palette, it reads
  // as a variant of "abstain": both are delegations to a non-DRep target.
  if (s.type === 'no_confidence') return 'abstain';
  return s.type;
}

interface FanStream {
  label: string;
  count: number;
  amount: bigint;
  colorKey: string;
}

/**
 * Top FAN_TOP sources become their own stream, EXCEPT that DRep-type sources
 * are further capped at the palette's three individual blue slots: only the
 * top 3 DReps by amount (the same three assignDrepColorIndices colors) stay
 * individual, any further DRep source (whether ranked 4th/5th within the top
 * FAN_TOP or beyond it) merges into one "Other DReps (n)" pseudo-stream.
 * Without this cap, a top FAN_TOP of 4-5 DReps would produce 4-5 individually
 * labeled ribbons sharing only 3 distinct colors between them. Non-DRep
 * sources (new/abstain/no_confidence/unknown) are never capped and always
 * stay individual. Identified arrivals only: notAnalyzed and unresolved
 * never enter the fan.
 */
function fanStreams(payload: ProvenancePayload): FanStream[] {
  const drepColor = assignDrepColorIndices(payload.sources);
  const isColoredDrep = (s: ProvenanceSource) =>
    s.type === 'drep' && s.drepId !== undefined && drepColor.has(s.drepId);

  const top = payload.sources.slice(0, FAN_TOP);
  const individual = top.filter(s => s.type !== 'drep' || isColoredDrep(s));

  const streams: FanStream[] = individual.map(s => ({
    label: sourceLabel(s),
    count: s.count,
    amount: BigInt(s.amount),
    colorKey: colorKeyFor(s, drepColor),
  }));

  // Every DRep source without one of the three colored slots merges here,
  // regardless of whether it ranked inside or outside the top FAN_TOP.
  const mergedDreps = payload.sources.filter(s => s.type === 'drep' && !isColoredDrep(s));
  if (mergedDreps.length > 0) {
    streams.push({
      label: `Other DReps (${mergedDreps.length})`,
      count: mergedDreps.reduce((a, s) => a + s.count, 0),
      amount: mergedDreps.reduce((a, s) => a + BigInt(s.amount), 0n),
      colorKey: 'drep-3',
    });
  }
  for (const s of payload.sources.slice(FAN_TOP)) {
    if (s.type === 'drep') continue; // already folded into mergedDreps above
    streams.push({
      label: sourceLabel(s),
      count: s.count,
      amount: BigInt(s.amount),
      colorKey: colorKeyFor(s, drepColor),
    });
  }
  return streams;
}

interface Thickness {
  stream: FanStream;
  px: number;
}

/** Scales stream amounts to pixel thickness, clamped to a readable minimum. */
function thicknesses(streams: FanStream[]): Thickness[] {
  const total = streams.reduce((a, s) => a + s.amount, 0n);
  if (total === 0n) return streams.map(stream => ({ stream, px: MIN_THICKNESS }));
  const scale = TARGET_TOTAL_THICKNESS / Number(total);
  return streams.map(stream => ({
    stream,
    px: Math.max(MIN_THICKNESS, Number(stream.amount) * scale),
  }));
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function svgText(x: number, y: number, className: string, text: string): SVGTextElement {
  const el = svgEl('text', { x: String(x), y: String(y), class: className });
  el.textContent = text;
  return el;
}

/** Builds the fan chart into an existing <svg viewBox="0 0 960 460"> element. */
function buildFan(svg: SVGSVGElement, streams: FanStream[]): void {
  svg.replaceChildren();
  const rows = thicknesses(streams);

  const leftTotal = rows.reduce((a, r) => a + r.px, 0) + BAND_GAP * Math.max(0, rows.length - 1);
  const rightTotal = rows.reduce((a, r) => a + r.px, 0);
  let leftY = (VIEW_H - leftTotal) / 2;
  let rightY = (VIEW_H - rightTotal) / 2;
  const rightNodeTop = rightY;

  for (const { stream, px } of rows) {
    const y0t = leftY;
    const y0b = leftY + px;
    const y1t = rightY;
    const y1b = rightY + px;

    const path = svgEl('path', {
      d: `M ${X0} ${y0t} C ${XM} ${y0t}, ${XM} ${y1t}, ${X1} ${y1t} L ${X1} ${y1b} C ${XM} ${y1b}, ${XM} ${y0b}, ${X0} ${y0b} Z`,
      class: `vpo-band vpo-band--${stream.colorKey}`,
    });
    svg.appendChild(path);

    const stub = svgEl('rect', {
      x: String(STUB_X),
      y: String(y0t),
      width: String(STUB_W),
      height: String(px),
      rx: '2',
      class: `vpo-stub vpo-stub--${stream.colorKey}`,
    });
    svg.appendChild(stub);

    const center = (y0t + y0b) / 2;
    if (px >= THIN_THRESHOLD) {
      svg.appendChild(svgText(STUB_LABEL_X, center - 2, 'vpo-label-name', stream.label));
      svg.appendChild(
        svgText(
          STUB_LABEL_X,
          center + 14,
          'vpo-label-sub',
          `${stream.count} · ${ada(stream.amount.toString())}`,
        ),
      );
    } else {
      const text = svgEl('text', {
        x: String(STUB_LABEL_X),
        y: String(center + 5),
        class: 'vpo-label-sub',
        'text-anchor': 'end',
      });
      const bold = document.createElementNS(SVG_NS, 'tspan');
      bold.setAttribute('class', 'vpo-label-name-inline');
      bold.textContent = stream.label;
      text.appendChild(bold);
      text.appendChild(
        document.createTextNode(` · ${stream.count} · ${ada(stream.amount.toString())}`),
      );
      svg.appendChild(text);
    }

    leftY += px + BAND_GAP;
    rightY += px;
  }

  const node = svgEl('rect', {
    x: String(X1),
    y: String(rightNodeTop),
    width: String(NODE_W),
    height: String(rightTotal),
    rx: '3',
    class: 'vpo-you-node',
  });
  svg.appendChild(node);

  const totalCount = streams.reduce((a, s) => a + s.count, 0);
  const totalAmount = streams.reduce((a, s) => a + s.amount, 0n);
  const nodeCenter = rightNodeTop + rightTotal / 2;
  svg.appendChild(svgText(YOU_LABEL_X, nodeCenter - 16, 'vpo-you-title', 'You'));
  svg.appendChild(
    svgText(YOU_LABEL_X, nodeCenter + 2, 'vpo-you-sub', `${totalCount} identified arrivals`),
  );
  svg.appendChild(svgText(YOU_LABEL_X, nodeCenter + 19, 'vpo-you-sub', 'still with you today'));
  svg.appendChild(
    svgText(YOU_LABEL_X, nodeCenter + 36, 'vpo-you-sub', ada(totalAmount.toString())),
  );
}

/** Mobile fallback for the fan: a stacked composition bar, same streams and colors. */
function buildBar(bar: HTMLElement, streams: FanStream[]): void {
  bar.replaceChildren();
  const total = streams.reduce((a, s) => a + s.amount, 0n);
  for (const stream of streams) {
    const span = document.createElement('span');
    span.className = `vpo-bar-seg vpo-bar-seg--${stream.colorKey}`;
    const share = total === 0n ? 0 : (Number(stream.amount) / Number(total)) * 100;
    span.style.width = `${share.toFixed(2)}%`;
    span.title = `${stream.label}: ${stream.count} · ${ada(stream.amount.toString())}`;
    bar.appendChild(span);
  }
}

type Segment = string | { bold: string };

function appendRich(el: HTMLElement, segments: Segment[]): void {
  el.replaceChildren();
  for (const seg of segments) {
    if (typeof seg === 'string') {
      el.appendChild(document.createTextNode(seg));
    } else {
      const strong = document.createElement('strong');
      strong.textContent = seg.bold;
      el.appendChild(strong);
    }
  }
}

function coverageSegments(payload: ProvenancePayload): Segment[] {
  const {
    analyzedCandidateCount,
    totalCandidateCount,
    analyzedCandidateAmount,
    totalCandidateAmount,
  } = payload.coverage;
  const totalAmt = Number(totalCandidateAmount);
  const pct = totalAmt > 0 ? Math.round((Number(analyzedCandidateAmount) / totalAmt) * 100) : 0;
  return [
    {
      bold: `${analyzedCandidateCount} of ${totalCandidateCount} accounts with recent delegation activity analyzed`,
    },
    `, largest by current stake · covering ${pct}% of their current stake`,
  ];
}

function returningSegments(payload: ProvenancePayload): Segment[] {
  return [
    { bold: String(payload.returningTotal) },
    ' of the analyzed arrivals had delegated to you before.',
  ];
}

/** The under-fan caption, or null when there is nothing outside the chart to report. */
function buildCaption(payload: ProvenancePayload): Segment[] | null {
  const clauses: Segment[][] = [];
  if (payload.notAnalyzed && payload.notAnalyzed.count > 0) {
    clauses.push([
      { bold: String(payload.notAnalyzed.count) },
      ` recent-activity accounts not analyzed (${ada(payload.notAnalyzed.amount)})`,
    ]);
  }
  if (payload.reclassifiedBaseCount > 0) {
    clauses.push([`${payload.reclassifiedBaseCount} were re-delegations within an existing stint`]);
  }
  if (payload.unresolved && payload.unresolved.count > 0) {
    clauses.push([`${payload.unresolved.count} could not be resolved`]);
  }
  if (clauses.length === 0) return null;
  const segments: Segment[] = ['Not in the chart: '];
  clauses.forEach((clause, i) => {
    if (i > 0) segments.push(' · ');
    segments.push(...clause);
  });
  return segments;
}

/** Full, unmerged source breakdown: one row per identified-arrival source. */
function buildTable(table: HTMLElement, payload: ProvenancePayload): void {
  table.replaceChildren();
  const drepColor = assignDrepColorIndices(payload.sources);
  const totalAmount = payload.sources.reduce((a, s) => a + BigInt(s.amount), 0n);

  for (const s of payload.sources) {
    const row = document.createElement('div');
    row.className = 'vpo-row';

    const dot = document.createElement('span');
    dot.className = `vpo-dot vpo-dot--${colorKeyFor(s, drepColor)}`;
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);

    const nameCell = document.createElement('span');
    nameCell.className = 'vpo-row__name';
    if (s.type === 'drep' && s.drepId) {
      const icon = document.createElement('span');
      icon.className = 'vpo-row__icon';
      icon.innerHTML = identiconSvg(s.hex ?? s.drepId, 18);
      const link = document.createElement('a');
      link.href = drepPath({ drepId: s.drepId, slug: s.slug });
      link.className = 'vpo-row__link';
      link.textContent = sourceLabel(s);
      appendAll(nameCell, icon, link);
    } else {
      const label = document.createElement('span');
      label.className = 'vpo-row__label';
      label.textContent = sourceLabel(s);
      nameCell.appendChild(label);
    }
    row.appendChild(nameCell);

    const count = document.createElement('span');
    count.className = 'vpo-row__num';
    count.textContent = String(s.count);
    row.appendChild(count);

    const amount = document.createElement('span');
    amount.className = 'vpo-row__num';
    amount.textContent = ada(s.amount);
    row.appendChild(amount);

    const share = document.createElement('span');
    share.className = 'vpo-row__num vpo-row__num--muted';
    const amt = BigInt(s.amount);
    const pct = totalAmount === 0n ? 0 : Math.round((Number(amt) / Number(totalAmount)) * 100);
    share.textContent = `${pct}%`;
    row.appendChild(share);

    table.appendChild(row);
  }
}

function renderArrivedKpi(container: HTMLElement, payload: ProvenancePayload): void {
  const count = payload.sources.reduce((a, s) => a + s.count, 0);
  const amount = payload.sources.reduce((a, s) => a + BigInt(s.amount), 0n);
  container.replaceChildren();

  const num = document.createElement('span');
  num.className = 'vpo-kpi__num';
  const pos = document.createElement('span');
  pos.className = 'vpo-kpi__pos';
  pos.textContent = `+${count.toLocaleString('en-US')}`;
  num.appendChild(pos);

  const sub = document.createElement('span');
  sub.className = 'vpo-kpi__sub';
  const analyzedCount = payload.coverage.analyzedCandidateCount;
  sub.textContent = analyzedCount === 0
    ? `${ada(amount.toString())} still with you`
    : `${ada(amount.toString())} still with you · among the ${analyzedCount.toLocaleString('en-US')} largest recent-activity accounts`;

  appendAll(container, num, sub);
}

async function fetchProvenance(windowEpochs: number, signal: AbortSignal): Promise<ProvenancePayload> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ window: windowEpochs }),
    signal,
  });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as ProvenancePayload;
}

export function renderVotingPowerOrigins(): void {
  const root = document.querySelector<HTMLElement>('[data-vpo-root]');
  if (!root) return;

  const status = root.querySelector<HTMLElement>('#vpo-status');
  const content = root.querySelector<HTMLElement>('[data-vpo-content]');
  const coverageLine = root.querySelector<HTMLElement>('[data-vpo-coverage]');
  const returningLine = root.querySelector<HTMLElement>('[data-vpo-returning]');
  const captionLine = root.querySelector<HTMLElement>('[data-vpo-caption]');
  const captionText = root.querySelector<HTMLElement>('[data-vpo-caption-text]');
  const fan = root.querySelector<SVGSVGElement>('#vpo-fan');
  const bar = root.querySelector<HTMLElement>('#vpo-bar');
  const tableSection = root.querySelector<HTMLElement>('[data-vpo-table-section]');
  const table = root.querySelector<HTMLElement>('#vpo-table');
  const kpiArrived = root.querySelector<HTMLElement>('#vpo-kpi-arrived');
  const segButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-window]'));

  if (
    !status ||
    !content ||
    !coverageLine ||
    !returningLine ||
    !captionLine ||
    !captionText ||
    !fan ||
    !bar ||
    !tableSection ||
    !table ||
    !kpiArrived
  ) {
    return;
  }

  function showStatus(kind: 'loading' | 'error' | 'empty', retry?: () => void): void {
    if (!status) return;
    status.hidden = false;
    if (content) content.hidden = true;
    if (tableSection) tableSection.hidden = true;
    status.replaceChildren();
    status.className = `vpo-status vpo-status--${kind}`;
    if (kind === 'loading') {
      const spinner = document.createElement('span');
      spinner.className = 'vpo-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = 'Analyzing… the first run in a while can take a moment.';
      appendAll(status, spinner, text);
    } else if (kind === 'error') {
      const text = document.createElement('span');
      text.textContent = 'Could not load your voting power origins.';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vpo-retry';
      button.textContent = 'Retry';
      if (retry) button.addEventListener('click', retry);
      appendAll(status, text, button);
    } else {
      const text = document.createElement('span');
      text.textContent = 'No new delegators arrived in this window.';
      status.appendChild(text);
    }
  }

  function render(payload: ProvenancePayload): void {
    renderArrivedKpi(kpiArrived as HTMLElement, payload);

    const empty = payload.sources.length === 0 && payload.notAnalyzed === null && payload.unresolved === null;
    if (empty) {
      showStatus('empty');
      return;
    }

    if (status) status.hidden = true;
    (content as HTMLElement).hidden = false;

    appendRich(coverageLine as HTMLElement, coverageSegments(payload));
    appendRich(returningLine as HTMLElement, returningSegments(payload));

    const caption = buildCaption(payload);
    if (caption) {
      (captionLine as HTMLElement).hidden = false;
      appendRich(captionText as HTMLElement, caption);
    } else {
      (captionLine as HTMLElement).hidden = true;
    }

    if (payload.sources.length > 0) {
      const streams = fanStreams(payload);
      buildFan(fan as SVGSVGElement, streams);
      buildBar(bar as HTMLElement, streams);
      buildTable(table as HTMLElement, payload);
      (fan as SVGSVGElement).style.display = '';
      (bar as HTMLElement).style.display = '';
      (tableSection as HTMLElement).hidden = false;
    } else {
      (fan as SVGSVGElement).style.display = 'none';
      (bar as HTMLElement).style.display = 'none';
      (tableSection as HTMLElement).hidden = true;
    }
  }

  let currentWindow = 12;
  // Guards against a slow response for an earlier window overwriting a newer
  // one: each load() call claims the next id, and only the still-current
  // call is allowed to touch the DOM once its fetch settles.
  let requestId = 0;
  let activeController: AbortController | null = null;

  async function load(windowEpochs: number): Promise<void> {
    currentWindow = windowEpochs;
    const id = ++requestId;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    showStatus('loading');
    try {
      const payload = await fetchProvenance(windowEpochs, controller.signal);
      if (id !== requestId) return; // a newer window switch has since started
      render(payload);
    } catch (err) {
      if (id !== requestId) return; // stale, a newer request already took over
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showStatus('error', () => {
        void load(currentWindow);
      });
    }
  }

  for (const button of segButtons) {
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      for (const b of segButtons) {
        b.classList.remove('is-active');
        b.setAttribute('aria-pressed', 'false');
      }
      button.classList.add('is-active');
      button.setAttribute('aria-pressed', 'true');
      const windowEpochs = Number(button.dataset.window);
      void load(windowEpochs);
    });
  }

  void load(12);
}
