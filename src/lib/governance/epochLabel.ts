// Formats an epoch number together with the calendar date its boundary is on,
// for the places on the submit page that would otherwise show a bare
// epoch number: committee term expiries, a chosen previous action's proposal
// epoch, the expiry cap sentence. Leaf module: depends only on network.ts's
// epoch math, so it stays safe to pull into the client bundle.
import { epochStartMs, epochFromUnix, type NetworkConfig } from '../config/network.js';

// Its own formatter rather than view.ts's formatEpochDate: that one writes the
// US order ("Jan 12, 2027") and reads unix seconds, and it is what the action
// list and the thread headers already show, so it cannot be turned around
// without moving every one of those dates. The submit page states a date
// inside a running sentence ("term ends in epoch 372, about 12 Jan 2027"),
// where the day-month-year order reads as part of the sentence instead of
// needing its comma.
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * "about 12 Jan 2027" for any epoch other than the one currently running, or
 * just "12 Jan 2027" for the current epoch, since that boundary already
 * happened (or is happening) rather than being a projection. Every other
 * epoch's start is derived from the network's fixed epoch length, which is
 * why it gets the qualifier. `now` decides which epoch counts as current,
 * defaulting to the real clock.
 */
function qualifiedDate(epoch: number, cfg: NetworkConfig, now: number): string {
  const date = DATE_FORMAT.format(new Date(epochStartMs(epoch, cfg)));
  const currentEpoch = epochFromUnix(now / 1000, cfg);
  return epoch === currentEpoch ? date : `about ${date}`;
}

/**
 * "epoch 372 (about 12 Jan 2027)": an epoch number plus the calendar date its
 * boundary is on. See qualifiedDate for when "about" is dropped.
 */
export function epochWithDate(epoch: number, cfg: NetworkConfig, now: number = Date.now()): string {
  return `epoch ${epoch} (${qualifiedDate(epoch, cfg, now)})`;
}

/**
 * The qualified date alone ("about 12 Jan 2027"), for callers that weave the
 * epoch number into their own sentence instead of parenthesizing the whole
 * thing (the committee member label's "term ends in epoch 372, about 12 Jan
 * 2027"). Same qualifier rule as epochWithDate.
 */
export function epochDateClause(epoch: number, cfg: NetworkConfig, now: number = Date.now()): string {
  return qualifiedDate(epoch, cfg, now);
}
