// The two predefined pseudo-DReps Koios returns in drep_list. They are not real
// voters: "always abstain" stake is excluded from active voting stake, and
// "always no confidence" is a standing no. Both are excluded from the directory
// and the concentration view so the figures reflect real DReps.
export const SPECIAL_DREP_IDS = ['drep_always_abstain', 'drep_always_no_confidence'] as const;
