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

// Cardanoscan base URLs per network.
const CARDANOSCAN_BASE: Record<CardanoNetwork, string> = {
  mainnet: 'https://cardanoscan.io',
  preprod: 'https://preprod.cardanoscan.io',
};

/** Returns the Cardanoscan URL for a transaction hash on the given network. */
export function txExplorerUrl(network: CardanoNetwork, txHash: string): string {
  return `${CARDANOSCAN_BASE[network]}/transaction/${txHash}`;
}

/**
 * Returns the Cardanoscan base URL for a given network.
 * Use txExplorerUrl for transaction links; this is exposed for callers that
 * need the root (e.g. governance-action links built with a different path).
 */
export function cardanoscanBase(network: CardanoNetwork): string {
  return CARDANOSCAN_BASE[network];
}

// Defaults to mainnet when unset so production needs no variable.
// Throws on an unknown explicit value (fail closed).
export function resolveNetwork(value: string | null | undefined): NetworkConfig {
  if (!value) return CONFIGS.mainnet;
  if (value === 'mainnet' || value === 'preprod') return CONFIGS[value];
  throw new Error(`invalid CARDANO_NETWORK: ${value}`);
}
