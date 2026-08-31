// The two predefined pseudo-DReps Koios returns in drep_list. They are not real
// voters: "always abstain" stake is excluded from active voting stake, and
// "always no confidence" is a standing no.
//
// Two-layer convention (binding for every metric, see also
// analytics/epochStatsContract.ts):
// - Representative DRep layer: real registered DReps only. Any aggregate that
//   makes a statement about DReps as actors (counts, concentration, gini,
//   coalitions, denominators of representative percentages, vote counts) MUST
//   exclude these ids, enforced in the query itself where possible.
// - Default delegation layer: these two ids, always reported separately
//   (their power and delegator counts are governance options people chose,
//   not representation).
// Known deviation: getActiveDrepStake (db/stakeParticipation.ts) still
// includes them in the landing composition denominator, to be settled with
// the analytics hub PR.
export const SPECIAL_DREP_IDS = ['drep_always_abstain', 'drep_always_no_confidence'] as const;
