// Derives the epoch a stake account started its CURRENT DRep delegation from a
// Koios /account_update_history response. "Since I delegated" means since the
// newest delegation_drep event, not the first one ever: a re-delegation restarts
// the window. Other action types (delegation_pool, registration, withdrawal) say
// nothing about DRep delegation and are ignored.
import type { AccountUpdateHistoryRow } from '../koios/client.js';

/**
 * The epoch of the newest delegation_drep event, or null when the rows contain
 * none (empty history, an account that never delegated to a DRep, or a Koios
 * response that omitted the address). Ordering is by absolute_slot, with a tie
 * broken on the higher epoch_no. The input may be unsorted and may mix several
 * stake addresses, so filter per address before calling.
 */
export function delegationStartEpoch(rows: AccountUpdateHistoryRow[]): number | null {
  let best: AccountUpdateHistoryRow | null = null;
  for (const row of rows) {
    if (row.action_type !== 'delegation_drep') continue;
    if (
      best === null ||
      row.absolute_slot > best.absolute_slot ||
      (row.absolute_slot === best.absolute_slot && row.epoch_no > best.epoch_no)
    ) {
      best = row;
    }
  }
  return best === null ? null : best.epoch_no;
}
