// Result line of the runway calculator, shared by the server render and the
// slider script so both always say the same thing.
import { formatAdaCompact } from '../format/ada.js';
import type { RunwayProjection } from './runwayProjection.js';

/** "At 532M ₳ a year the treasury is empty around 2031." */
export function runwayResultText(spendPerYear: bigint, proj: RunwayProjection): string {
  const amount = formatAdaCompact(String(spendPerYear), 0) ?? '0 ₳';
  return proj.endYear != null
    ? `At ${amount} a year the treasury is empty around ${proj.endYear}.`
    : `At ${amount} a year the treasury lasts beyond ${proj.horizonYear}.`;
}
