// When a proposal's deposit comes back at the latest. The ledger keeps a
// proposal for gov_action_lifetime epochs after the one it was submitted in,
// drops an unratified one at the next boundary and refunds the deposit there.
// Preprod shows it: proposals from epoch 310 with a lifetime of 6 expired and
// were refunded in epoch 317. An enacted action is refunded earlier, at its
// enactment.
//
// The refund goes to the proposal's reward account only while that account is
// registered. A deregistered one forfeits the deposit to the treasury, which
// is why the submit page warns about it next to every mention of the refund.

/**
 * The epoch at whose start an unratified proposal submitted now is refunded,
 * from the current /epoch_params row. Null when the row lacks either figure.
 */
export function latestRefundEpoch(row: { epoch_no?: number | null; gov_action_lifetime?: unknown } | null): number | null {
  const epoch = row?.epoch_no;
  const lifetime = row?.gov_action_lifetime;
  if (typeof epoch !== 'number' || typeof lifetime !== 'number') return null;
  return epoch + lifetime + 1;
}

/** The warning itself, one sentence for every place that mentions the refund. */
export const KEEP_STAKE_KEY_REGISTERED =
  'Keep the stake key registered until the deposit is back. If it is deregistered before that, the ledger sends the deposit to the treasury instead.';
