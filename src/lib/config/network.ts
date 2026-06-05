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

// Defaults to mainnet when unset so production needs no variable.
// Throws on an unknown explicit value (fail closed).
export function resolveNetwork(value: string | null | undefined): NetworkConfig {
  if (!value) return CONFIGS.mainnet;
  if (value === 'mainnet' || value === 'preprod') return CONFIGS[value];
  throw new Error(`invalid CARDANO_NETWORK: ${value}`);
}
