import { availableOn, type CardanoNetwork } from '../config/network.js';

/**
 * The networks DRep groups run on, the one switch for every groups surface: pages, API routes,
 * nav, search, account menu, DRep profile, group signer login and the gov-sync phases.
 */
export const DREP_GROUPS_NETWORKS: readonly CardanoNetwork[] = ['preprod', 'mainnet'];

/** Whether DRep groups run on the network, read from DREP_GROUPS_NETWORKS. */
export function drepGroupsAvailable(network: CardanoNetwork | undefined, networks: readonly CardanoNetwork[] = DREP_GROUPS_NETWORKS): boolean {
  return network !== undefined && availableOn(networks, network);
}
