// The per-body rows of the voting card (DRep, SPO, CC) with their threshold verdict
// and stake model. Shared by the sidebar card and the Votes tab, so the path to pass
// shown in both is computed from the same rows.
import type { GovernanceAction } from '../db/governance.js';
import type { ProtocolParams } from '../db/protocolParams.js';
import type { BodyStakeView } from './fullStakeView.js';
import { parameterChangeScope } from './onchain.js';
import { ccBlockedAtBoundary, type PassCandidate } from './passPath.js';
import { passPathRow, type PassListView, type PassPathRowView } from './passPathView.js';
import { evaluateThresholds, hasOnchainThreshold, readThresholdSnapshot } from './thresholds.js';
import { bodyStake, compositionAmounts, overviewRowVoting } from './view.js';

export interface VotingCardRow {
  body: 'DRep' | 'SPO' | 'CC';
  label: string;
  composition: ReturnType<typeof overviewRowVoting>['bodies'][number]['composition'];
  amounts: ReturnType<typeof compositionAmounts>;
  participation: number | null;
  thresholdPct: number | null;
  met: boolean | null;
  stake: BodyStakeView | null;
}

export interface VotingCardRows {
  rows: VotingCardRow[];
  isActive: boolean;
  ccBlocked: boolean;
  hasThreshold: boolean;
  paramTouchesSecurity: boolean;
}

export function votingCardRows(
  action: GovernanceAction,
  params: ProtocolParams | null,
  opts: { drepStakeTotal: number | null; ccBoundarySize: number | null },
): VotingCardRows {
  // ParameterChange voting bodies depend on which parameters change: SPOs vote only on
  // security-relevant ones. Derive that from the payload, null for other types.
  const paramScope = action.type === 'ParameterChange' ? parameterChangeScope(action.onchainPayload) : null;
  const paramTouchesSecurity = paramScope?.touchesSecurity ?? false;

  const rowOpts = { drepStakeTotal: opts.drepStakeTotal, committeeSize: params?.committeeSize ?? null };
  // The CC "not voted" count uses the boundary committee, the same seats the path to
  // pass counts, so the two never disagree.
  const amountOpts = {
    drepStakeTotal: opts.drepStakeTotal,
    committeeSize: opts.ccBoundarySize ?? params?.committeeSize ?? null,
  };
  const hasThreshold = hasOnchainThreshold(action.type);

  // Prefer the frozen per-body snapshot, fall back to live params only when absent
  // (active actions not yet snapshotted). Never render an old action's threshold from
  // today's params.
  const snapshot = readThresholdSnapshot(action.thresholdsJson);

  const { bodies } = overviewRowVoting(action, rowOpts, { paramTouchesSecurity });
  // The verdict is judged on the same yes share the row shows (see bodyComposition).
  const shownYes = (body: 'DRep' | 'SPO' | 'CC'): number | null =>
    bodies.find((b) => b.body === body)?.composition?.yes ?? null;
  const liveThresholds =
    !snapshot && hasThreshold && params
      ? evaluateThresholds(
          { type: action.type, drepYesPct: shownYes('DRep'), spoYesPct: shownYes('SPO'), ccYesPct: shownYes('CC'), paramScope },
          params,
        )
      : null;
  const thresholdPctFor = (body: 'DRep' | 'SPO' | 'CC'): number | null =>
    snapshot
      ? body === 'DRep'
        ? snapshot.drep
        : body === 'SPO'
          ? snapshot.spo
          : snapshot.cc
      : (liveThresholds?.find((x) => x.body === body)?.thresholdPct ?? null);

  // On an open action the stored committee gate was judged on the live size, which
  // still counts a member in their expiry epoch, so the boundary size is checked too.
  const isActive = action.status === 'active';
  const ccBlocked = ccBlockedAtBoundary(opts.ccBoundarySize, params?.committeeMinSize ?? null, snapshot?.ccBelowMinSize ?? null);

  const rows = bodies.map((b): VotingCardRow => {
    const thr = thresholdPctFor(b.body);
    const t = liveThresholds?.find((x) => x.body === b.body) ?? null;
    const yes = b.composition?.yes ?? null;
    // From a frozen snapshot, the CC "Met" also honors the committee quorum gate
    // (committee below its minimum size cannot ratify, regardless of the yes share).
    const verdict = t
      ? t.met
      : thr == null || yes == null
        ? null
        : b.body === 'CC' && snapshot?.ccBelowMinSize
          ? false
          : yes >= thr;
    // Never Met next to the "committee below its minimum size" line.
    const met = b.body === 'CC' && isActive && ccBlocked && verdict === true ? false : verdict;
    return {
      body: b.body,
      label: b.label,
      composition: b.composition,
      amounts: compositionAmounts(action, b.body, amountOpts),
      participation: b.participation,
      thresholdPct: thr,
      met,
      // The captured stake model, null for CC (seats, not stake) and for actions whose
      // buckets predate the capture.
      stake: bodyStake(action, b.body, thr),
    };
  });

  return { rows, isActive, ccBlocked, hasThreshold, paramTouchesSecurity };
}

type PassPathOpts = {
  drepStakeTotal: number | null;
  ccBoundarySize: number | null;
  passCandidates: PassCandidate[] | null;
  actionHref: string;
};

/**
 * The card rows with their path to pass attached (null where the body is met, the
 * action closed, or no path can be shown). The sidebar card and the Votes tab both
 * read from here, so the link count and the list never disagree.
 */
export function votingCardRowsWithPath(
  action: GovernanceAction,
  params: ProtocolParams | null,
  opts: PassPathOpts,
): Omit<VotingCardRows, 'rows'> & { rows: (VotingCardRow & { path: PassPathRowView | null })[] } {
  const card = votingCardRows(action, params, opts);
  const ctx = {
    isActive: card.isActive,
    ccBlocked: card.ccBlocked,
    ccBoundarySize: opts.ccBoundarySize,
    cc: { yes: action.ccYes ?? 0, no: action.ccNo ?? 0, abstain: action.ccAbstain ?? 0 },
    passCandidates: opts.passCandidates,
    actionHref: opts.actionHref,
  };
  return { ...card, rows: card.rows.map((r) => ({ ...r, path: passPathRow(r, ctx) })) };
}

/** The DRep switch list for the Votes tab section, or null when the card shows none. */
export function drepPassList(action: GovernanceAction, params: ProtocolParams | null, opts: PassPathOpts): PassListView | null {
  return votingCardRowsWithPath(action, params, opts).rows.find((r) => r.body === 'DRep')?.path?.list ?? null;
}
