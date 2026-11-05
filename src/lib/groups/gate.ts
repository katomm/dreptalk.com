import { availableOn, type CardanoNetwork } from '../config/network.js';

/**
 * The networks DRep groups run on, the one switch for every groups surface: pages, API routes,
 * nav, search, account menu, DRep profile, group signer login and the gov-sync phases. Adding
 * 'mainnet' turns them all on there together. Before that, mainnet D1 needs the group migrations
 * 0124, 0126, 0127 and 0128, and the preprod wording of src/content/guides/drep-groups.md changes
 * with it.
 */
export const DREP_GROUPS_NETWORKS: readonly CardanoNetwork[] = ['preprod'];

/** Whether DRep groups run on the network, read from DREP_GROUPS_NETWORKS. */
export function drepGroupsAvailable(network: CardanoNetwork | undefined, networks: readonly CardanoNetwork[] = DREP_GROUPS_NETWORKS): boolean {
  return network !== undefined && availableOn(networks, network);
}
