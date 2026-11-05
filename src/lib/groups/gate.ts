import type { CardanoNetwork } from '../config/network.js';

/** The networks DRep groups run on. */
export const DREP_GROUPS_NETWORKS: readonly CardanoNetwork[] = ['preprod'];

/** DRep groups are live on preprod only. */
export function drepGroupsAvailable(network: CardanoNetwork | undefined): boolean {
  return network !== undefined && DREP_GROUPS_NETWORKS.includes(network);
}
