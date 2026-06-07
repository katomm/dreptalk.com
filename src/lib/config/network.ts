export type CardanoNetwork = 'mainnet' | 'preprod';

export interface NetworkConfig {
  network: CardanoNetwork;
  koiosBaseUrl: string;
  addrPrefix: string;
  stakePrefix: string;
  networkId: number;
}

const CONFIGS: Record<CardanoNetwork, NetworkConfig> = {
  mainnet: {
    network: 'mainnet',
    koiosBaseUrl: 'https://api.koios.rest/api/v1',
    addrPrefix: 'addr',
    stakePrefix: 'stake',
    networkId: 1,
  },
  preprod: {
    network: 'preprod',
    koiosBaseUrl: 'https://preprod.koios.rest/api/v1',
    addrPrefix: 'addr_test',
    stakePrefix: 'stake_test',
    networkId: 0,
  },
};

// The Cardano Foundation explorer landing page lets each user pick their own
// preferred explorer, so we link through it instead of hard-coding a single one
// (more neutral). mainnet is the default and needs no parameter; other networks
// are passed as a query param. https://github.com/cardano-foundation/cf-explorer-landing
const EXPLORER_BASE = 'https://explorer.cardano.org';

function explorerNetworkSuffix(network: CardanoNetwork): string {
  return network === 'mainnet' ? '' : `&network=${network}`;
}

/** Neutral explorer-landing URL for a transaction hash on the given network. */
export function txExplorerUrl(network: CardanoNetwork, txHash: string): string {
  return `${EXPLORER_BASE}/transaction?id=${encodeURIComponent(txHash)}${explorerNetworkSuffix(network)}`;
}

/** Neutral explorer-landing URL for a governance action (bech32 gov_action id). */
export function governanceActionUrl(network: CardanoNetwork, proposalId: string): string {
  return `${EXPLORER_BASE}/governance-action?id=${encodeURIComponent(proposalId)}${explorerNetworkSuffix(network)}`;
}

// Defaults to mainnet when unset so production needs no variable.
// Throws on an unknown explicit value (fail closed).
export function resolveNetwork(value: string | null | undefined): NetworkConfig {
  if (!value) return CONFIGS.mainnet;
  if (value === 'mainnet' || value === 'preprod') return CONFIGS[value];
  throw new Error(`invalid CARDANO_NETWORK: ${value}`);
}
