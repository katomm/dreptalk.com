// The voting power gate for loading vote rationales, shared by the fetch job
// (rationaleSync.ts) and the pages that explain a rationale it skipped.

// Fetch rationales for voters with at least 10,000 ada of voting power. Set low
// enough to cover small-but-active DReps who write thoughtful rationales, while
// still skipping dust-weight voters. Below this line only a few hundred anchored
// votes exist site-wide, so the gate mostly bounds ongoing fetches, not backlog.
// Lovelace = ada * 1e6.
export const VOTE_RATIONALE_MIN_POWER_LOVELACE = 10_000_000_000;

/**
 * True when a DRep's current voting power is under the fetch gate above (or
 * unknown, which the gate's SQL also skips), so an anchored rationale is never
 * loaded and the UI says so instead of reporting it as unavailable.
 */
export function belowRationaleGate(votingPower: string | number | null | undefined): boolean {
  return !(Number(votingPower ?? 0) >= VOTE_RATIONALE_MIN_POWER_LOVELACE);
}

/** Tooltip for a rationale the gate kept out. */
export const RATIONALE_NOT_LOADED_TITLE = 'Rationales are loaded for DReps with at least 10,000 ada of voting power';
