// Substance signals over one window pack: the handful of things that, if any
// of them is present, an edition probably has something to say. Inputs to a
// judgement, never the judgement itself, and pure, so the same pack always
// yields the same signals.
import { RARE_TYPES, type PackAction, type WindowPack } from './pack.js';

export interface Signals {
  rareDecided: Array<{ id: string; type: string; status: string; epoch: number | null }>;
  largeWithdrawalsEnactedAda: Array<{ id: string; ada: number; epoch: number }>;
  failedWithMajority: Array<{ id: string; drepYesPct: number; bar: number }>;
  records: Array<{ metric: string; value: number; kind: 'lowest_since' | 'highest_since'; sinceEpoch: number }>;
  topTenPatterns: Array<{ id: string; vote: string; topTenCount: number }>;
}

/** A treasury withdrawal at or above this is worth naming on its own. */
const LARGE_WITHDRAWAL_ADA = 20_000_000;
/** Identical non-yes ballots among the ten largest DReps, from which it reads as a bloc. */
const TOP_TEN_BLOC = 5;
const TOP_TEN = 10;

/** The epoch of an action's last event inside the window, null when it had none. */
function lastEventEpoch(a: PackAction): number | null {
  return a.eventsInWindow.length > 0 ? a.eventsInWindow[a.eventsInWindow.length - 1].epoch : null;
}

export function computeSignals(pack: WindowPack): Signals {
  const focus = [...pack.actions.events, ...pack.actions.closingAtBoundary];

  const rareDecided = focus
    .filter((a) => RARE_TYPES.has(a.type))
    .map((a) => ({ id: a.id, type: a.type, status: a.status, epoch: lastEventEpoch(a) }));

  const largeWithdrawalsEnactedAda: Signals['largeWithdrawalsEnactedAda'] = [];
  for (const a of pack.actions.events) {
    const enacted = a.eventsInWindow.find((e) => e.kind === 'enacted');
    if (enacted && a.withdrawalAda != null && a.withdrawalAda >= LARGE_WITHDRAWAL_ADA) {
      largeWithdrawalsEnactedAda.push({ id: a.id, ada: a.withdrawalAda, epoch: enacted.epoch });
    }
  }

  // A majority of DRep power behind an action that still did not pass is the
  // clearest case where the threshold, not the vote, decided the outcome.
  const expiredOrClosing = [
    ...pack.actions.events.filter((a) => a.eventsInWindow.some((e) => e.kind === 'expired')),
    ...pack.actions.closingAtBoundary,
  ];
  const failedWithMajority: Signals['failedWithMajority'] = [];
  for (const a of expiredOrClosing) {
    const yes = a.tally.drep.yesPct;
    const bar = a.thresholds.drep;
    if (yes != null && bar != null && yes >= 50 && yes < bar) failedWithMajority.push({ id: a.id, drepYesPct: yes, bar });
  }

  const records: Signals['records'] = [];
  for (const r of pack.records) {
    // A range of one epoch, or a series that never moved, holds no record:
    // its end value is trivially both the lowest and the highest.
    if (r.rangeFrom >= r.rangeTo || r.min.value === r.max.value) continue;
    if (r.endValue === r.min.value) records.push({ metric: r.metric, value: r.endValue, kind: 'lowest_since', sinceEpoch: r.rangeFrom });
    if (r.endValue === r.max.value) records.push({ metric: r.metric, value: r.endValue, kind: 'highest_since', sinceEpoch: r.rangeFrom });
  }

  const topTenPatterns: Signals['topTenPatterns'] = [];
  const topTen = pack.topDreps.slice(0, TOP_TEN);
  for (const a of focus) {
    const counts = new Map<string, number>();
    for (const d of topTen) {
      const ballot = d.ballots[a.id];
      // Yes is the ordinary outcome, a bloc of it says nothing. Not voting at
      // all is covered by the silent-DRep figures, not by a ballot pattern.
      if (!ballot || ballot === 'Yes' || ballot === 'did not vote') continue;
      counts.set(ballot, (counts.get(ballot) ?? 0) + 1);
    }
    for (const [vote, n] of counts) {
      if (n >= TOP_TEN_BLOC) topTenPatterns.push({ id: a.id, vote, topTenCount: n });
    }
  }

  return { rareDecided, largeWithdrawalsEnactedAda, failedWithMajority, records, topTenPatterns };
}
