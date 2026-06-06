// Shared Cardano transaction metadata helpers for DRepTalk.
// CIP-20 transaction message metadata (label 674).
import * as TransactionMetadatum from '@evolution-sdk/evolution/TransactionMetadatum';

/**
 * CIP-20 metadata label for transaction messages.
 * All DRepTalk-initiated on-chain transactions attach this label so that
 * chain observers can attribute the action to the platform.
 */
export const DREPTALK_CIP20_LABEL = 674n;

/**
 * Returns the CIP-20 message body metadatum for DRepTalk attribution.
 *
 * The resulting value is a map: { msg: ["dreptalk.com"] }
 * to be attached at label 674 on any transaction this site builds.
 *
 * CIP-20 requires that each string in the msg list is at most 64 bytes.
 * "dreptalk.com" is 12 bytes, well within that limit.
 */
export function dreptalkCip20Metadatum(): TransactionMetadatum.TransactionMetadatum {
  return TransactionMetadatum.fromEntries([
    [TransactionMetadatum.text('msg'), TransactionMetadatum.array([TransactionMetadatum.text('dreptalk.com')])],
  ]);
}
