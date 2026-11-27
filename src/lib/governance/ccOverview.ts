// Committee-wide figures for the /cc/ index: the fact line above the member
// lists and the seat timeline. Built from the same index rows the lists show,
// so the counts on the page cannot disagree with each other.
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import type { CcIndexRow } from './ccProfile.js';

export interface CcFacts {
  /** Members whose seat is active in the next epoch. */
  activeSeats: number;
  minSize: number | null;
  /** Share of Yes votes the committee needs, as a percentage. */
  thresholdPct: number | null;
  maxTermEpochs: number | null;
  /** The active seat whose term ends first. */
  nextTermEnd: { coldKeyHex: string; name: string | null; epoch: number } | null;
}

export interface CcTimelineBar {
  coldKeyHex: string;
  name: string | null;
  standing: CcIndexRow['standing'];
  from: number;
  /** Last epoch served, the current epoch for an active seat. */
  servedTo: number;
  /** Epoch the running term expires, only for an active seat. */
  termEnd: number | null;
}

export interface CcTimeline {
  start: number;
  end: number;
  now: number;
  bars: CcTimelineBar[];
  ticks: number[];
}

/** The term of the committee version still open for this key. */
function openTermEnd(members: CommitteeMemberTerm[], coldKeyHex: string): number | null {
  const open = members.filter((m) => m.coldKeyHex === coldKeyHex && m.versionTo == null);
  return open.length > 0 ? Math.max(...open.map((m) => m.termExpiration)) : null;
}

export function buildCcFacts(input: {
  rows: CcIndexRow[];
  members: CommitteeMemberTerm[];
  minSize: number | null;
  threshold: number | null;
  maxTermEpochs: number | null;
}): CcFacts {
  const { rows, members, minSize, threshold, maxTermEpochs } = input;
  const active = rows.filter((r) => r.standing === 'Active');
  let nextTermEnd: CcFacts['nextTermEnd'] = null;
  for (const r of active) {
    const epoch = openTermEnd(members, r.coldKeyHex);
    if (epoch != null && (nextTermEnd == null || epoch < nextTermEnd.epoch)) {
      nextTermEnd = { coldKeyHex: r.coldKeyHex, name: r.name, epoch };
    }
  }
  return {
    activeSeats: active.length,
    minSize,
    thresholdPct: threshold == null ? null : threshold * 100,
    maxTermEpochs,
    nextTermEnd,
  };
}

const TICK_STEPS = [10, 25, 50, 100, 200];

function ticksFor(start: number, end: number): number[] {
  const span = end - start;
  const step = TICK_STEPS.find((s) => span / s <= 6) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  return ticks;
}

/** One bar per member in the order of the index rows, null without a known current epoch. */
export function buildCcTimeline(rows: CcIndexRow[], members: CommitteeMemberTerm[], currentEpoch: number | null): CcTimeline | null {
  if (currentEpoch == null || rows.length === 0) return null;
  const bars: CcTimelineBar[] = rows.map((r) => {
    const running = r.tenure.to == null;
    return {
      coldKeyHex: r.coldKeyHex,
      name: r.name,
      standing: r.standing,
      from: r.tenure.from,
      servedTo: running ? currentEpoch : (r.tenure.to as number),
      termEnd: running ? openTermEnd(members, r.coldKeyHex) : null,
    };
  });
  const start = Math.min(...bars.map((b) => b.from));
  const end = Math.max(currentEpoch, ...bars.map((b) => Math.max(b.servedTo, b.termEnd ?? b.servedTo))) + 1;
  return { start, end, now: currentEpoch, bars, ticks: ticksFor(start, end) };
}

/** Left offset and width of an epoch range on the timeline, as percentages. */
export function timelineSpan(t: CcTimeline, from: number, to: number): { left: number; width: number } {
  const total = t.end - t.start;
  const left = ((from - t.start) / total) * 100;
  const width = ((to + 1 - from) / total) * 100;
  return { left, width };
}
