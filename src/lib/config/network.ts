export type CardanoNetwork = 'mainnet' | 'preprod';

export interface NetworkConfig {
  network: CardanoNetwork;
  koiosBaseUrl: string;
  addrPrefix: string;
  stakePrefix: string;
  networkId: number;
  // A known epoch boundary, used to turn an epoch number into a calendar date
  // (e.g. "voting ends on ..."). Cardano epochs are a fixed length, so one
  // verified anchor plus EPOCH_LENGTH_SECONDS pins every other boundary.
  epochAnchor: { epoch: number; unixSeconds: number };
  // Public origin of the site for this network; used wherever an absolute
  // link must be rendered outside the request context (e.g. bot messages).
  siteOrigin: string;
}

// Both networks run 5-day epochs (same fact as EPOCH_DAYS in governance/view.ts,
// expressed in seconds here for boundary math).
export const EPOCH_LENGTH_SECONDS = 5 * 24 * 60 * 60; // 432000

const CONFIGS: Record<CardanoNetwork, NetworkConfig> = {
  mainnet: {
    network: 'mainnet',
    koiosBaseUrl: 'https://api.koios.rest/api/v1',
    addrPrefix: 'addr',
    stakePrefix: 'stake',
    networkId: 1,
    // Shelley start: epoch 208 began 2020-07-29T21:44:51Z.
    epochAnchor: { epoch: 208, unixSeconds: 1596059091 },
    siteOrigin: 'https://dreptalk.com',
  },
  preprod: {
    network: 'preprod',
    koiosBaseUrl: 'https://preprod.koios.rest/api/v1',
    addrPrefix: 'addr_test',
    stakePrefix: 'stake_test',
    networkId: 0,
    // preprod system start: epoch 0 began 2022-06-21T00:00:00Z.
    epochAnchor: { epoch: 0, unixSeconds: 1655769600 },
    siteOrigin: 'https://preprod.dreptalk.com',
  },
};

/**
 * Unix-seconds timestamp of the start of the given epoch, derived from the
 * network's verified anchor and the fixed epoch length. Pure and deterministic;
 * the calendar formatting lives in governance/view.ts (formatEpochDate).
 */
export function epochStartUnix(epoch: number, cfg: NetworkConfig): number {
  return cfg.epochAnchor.unixSeconds + (epoch - cfg.epochAnchor.epoch) * EPOCH_LENGTH_SECONDS;
}

/** Same boundary as epochStartUnix but in unix milliseconds, for JS Date and topic timestamps. */
export function epochStartMs(epoch: number, cfg: NetworkConfig): number {
  return epochStartUnix(epoch, cfg) * 1000;
}

/** Epoch number containing the given unix-seconds timestamp. Inverse of epochStartUnix. */
export function epochFromUnix(unixSeconds: number, cfg: NetworkConfig): number {
  return cfg.epochAnchor.epoch + Math.floor((unixSeconds - cfg.epochAnchor.unixSeconds) / EPOCH_LENGTH_SECONDS);
}

export interface EpochProgress {
  /** The currently running epoch (the one containing `nowMs`). */
  epoch: number;
  /** Start of the next epoch, in unix milliseconds: when this epoch ends. */
  endsUnixMs: number;
  /** Whole days until the boundary, rounded up. Always 1..5 for a live epoch. */
  daysLeft: number;
  /** Position within the epoch, 0 at its start to 1 at its end. */
  fractionElapsed: number;
}

/**
 * Where we are in the currently running epoch: its number, when it ends, how
 * many whole days remain, and how far it has elapsed (0..1). Pure and
 * deterministic from the network's epoch anchor and the fixed 5-day length, so
 * it needs no chain query. Drives the movers page's epoch indicator; a stale
 * edge cache only shifts fractionElapsed by minutes over a 5-day span.
 */
export function currentEpochProgress(nowMs: number, cfg: NetworkConfig): EpochProgress {
  const nowSeconds = nowMs / 1000;
  const epoch = epochFromUnix(nowSeconds, cfg);
  const startMs = epochStartMs(epoch, cfg);
  const endsUnixMs = epochStartMs(epoch + 1, cfg);
  const fractionElapsed = Math.min(1, Math.max(0, (nowMs - startMs) / (endsUnixMs - startMs)));
  const daysLeft = Math.max(1, Math.ceil((endsUnixMs - nowMs) / (24 * 60 * 60 * 1000)));
  return { epoch, endsUnixMs, daysLeft, fractionElapsed };
}

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
  // Path form, not the ?id= query form. The explorer.cardano.org switcher crashes on
  // the query form for governance actions: it reads a `governance-action` query key,
  // not `id`, then calls startsWith on the resulting null. The path form resolves fine.
  const net = network === 'mainnet' ? '' : `?network=${network}`;
  return `${EXPLORER_BASE}/governance-action/${encodeURIComponent(proposalId)}${net}`;
}

// Defaults to mainnet when unset so production needs no variable.
// Throws on an unknown explicit value (fail closed).
export function resolveNetwork(value: string | null | undefined): NetworkConfig {
  if (!value) return CONFIGS.mainnet;
  if (value === 'mainnet' || value === 'preprod') return CONFIGS[value];
  throw new Error(`invalid CARDANO_NETWORK: ${value}`);
}
