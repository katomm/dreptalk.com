import type { CardanoNetwork } from '../config/network.js';

/** DRep groups are live on preprod only. */
export function drepGroupsAvailable(network: CardanoNetwork | undefined): boolean {
  return network === 'preprod';
}
