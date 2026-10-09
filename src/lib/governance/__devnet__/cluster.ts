// A local Conway devnet for the parameter change tests: cardano-node, Kupo and
// Ogmios in Docker through @evolution-sdk/devnet. Only the devnet suite
// imports this file (npm run test:devnet), so the default suite never needs
// Docker.
//
// The genesis carries the real constitution guardrail hash, a two member
// committee (accounts 3 and 4 of the test mnemonic, hot key equal to cold
// key), staking parameters inside the constitution's bounds and one second
// epochs (50 slots of 20 ms), so a proposal can ratify and enact within a
// test run.
import * as Cluster from '@evolution-sdk/devnet/Cluster';
import * as Config from '@evolution-sdk/devnet/Config';
import * as Container from '@evolution-sdk/devnet/Container';
import * as Genesis from '@evolution-sdk/devnet/Genesis';
import { Address, Bytes, Client, preprod, type UTxO } from '@evolution-sdk/evolution';
import { GUARDRAIL_SCRIPT_HASH_HEX } from '../guardrailScript.js';

export const TEST_MNEMONIC =
  'test test test test test test test test test test test test test test test test test test test test test test test sauce';

/** Accounts 0 to 4 of the test mnemonic are funded, 3 and 4 sit on the committee. */
export const FUNDED_ACCOUNTS = [0, 1, 2, 3, 4] as const;
export const COMMITTEE_ACCOUNTS = [3, 4] as const;
const FUNDS_PER_ACCOUNT = 300_000_000_000;
/** The node socket inside the devnet's cardano-node container. */
const NODE_SOCKET = '/opt/cardano/ipc/node.socket';

function makeSeedClient(cluster: Cluster.Cluster, accountIndex: number) {
  return Client.make(Cluster.getChain(cluster))
    .withKupmios({
      kupoUrl: `http://localhost:${cluster.ports.kupo}`,
      ogmiosUrl: `http://localhost:${cluster.ports.ogmios}`,
    })
    .withSeed({ mnemonic: TEST_MNEMONIC, accountIndex, addressType: 'Base' });
}

export type DevnetClient = ReturnType<typeof makeSeedClient>;

export interface DevnetHandle {
  cluster: Cluster.Cluster;
  /** The SDK's own seed client against the devnet (Kupo and Ogmios), never the app's Koios or CIP-30 client. */
  client(accountIndex: number): DevnetClient;
  /** The genesis UTxO of a funded account, for its first transaction before Kupo has indexed anything. */
  genesisUtxo(accountIndex: number): UTxO.UTxO;
  /** One Ogmios JSON-RPC call over HTTP. Throws with the Ogmios error when the call fails. */
  ogmios<T>(method: string, params?: unknown): Promise<T>;
  /**
   * A cardano-cli query inside the node container, parsed as JSON. For
   * figures Ogmios 6.14 reports wrongly against node 10.5: its
   * rewardAccountSummaries shows 0 rewards where the ledger holds a refund.
   */
  cli<T>(args: string[]): Promise<T>;
  /** Polls the probe every 500 ms until it returns a value, throws with the last value seen at the deadline. */
  waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs?: number): Promise<T>;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON with bigints written as strings, for error messages. */
export function show(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

async function ogmiosCall<T>(port: number, method: string, params?: unknown): Promise<T> {
  const res = await fetch(`http://localhost:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }), id: null }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined) throw new Error(`Ogmios ${method} failed: ${show(body.error)}`);
  return body.result as T;
}

async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null) return value;
      last = value;
    } catch (err) {
      last = err instanceof Error ? err.message : err;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}. Last seen: ${show(last)}`);
    await sleep(500);
  }
}

/**
 * Starts a fresh devnet named `name`. The caller must call stop() in its
 * afterAll, which also removes the containers and the network. A failure
 * after the containers exist removes them before rethrowing.
 */
export async function startDevnet(name: string): Promise<DevnetHandle> {
  const addresses = await Promise.all(
    FUNDED_ACCOUNTS.map((accountIndex) =>
      Client.make(preprod).withSeed({ mnemonic: TEST_MNEMONIC, accountIndex, addressType: 'Base' }).address(),
    ),
  );
  const [cc1, cc2] = COMMITTEE_ACCOUNTS.map((i) => Bytes.toHex(addresses[i]!.paymentCredential.hash));

  const shelleyGenesis: Config.ShelleyGenesis = {
    ...Config.DEFAULT_SHELLEY_GENESIS,
    slotLength: 0.02,
    epochLength: 50,
    activeSlotsCoeff: 1.0,
    initialFunds: Object.fromEntries(addresses.map((a) => [Address.toHex(a), FUNDS_PER_ACCOUNT])),
    protocolParams: {
      ...Config.DEFAULT_SHELLEY_GENESIS.protocolParams,
      nOpt: 500,
      a0: 0.3,
      rho: 0.003,
      tau: 0.2,
      minPoolCost: 170_000_000,
    },
  };
  const conwayGenesis: Config.ConwayGenesis = {
    ...Config.DEFAULT_CONWAY_GENESIS,
    govActionLifetime: 30,
    dRepActivity: 1000,
    committeeMinSize: 2,
    constitution: { ...Config.DEFAULT_CONWAY_GENESIS.constitution, script: GUARDRAIL_SCRIPT_HASH_HEX },
    committee: {
      members: { [`keyHash-${cc1}`]: 1000, [`keyHash-${cc2}`]: 1000 },
      threshold: 0.66,
    },
  };

  const genesisUtxos = await Genesis.calculateUtxosFromConfig(shelleyGenesis);
  const genesisByAccount = new Map<number, UTxO.UTxO>();
  addresses.forEach((address, i) => {
    const utxo = genesisUtxos.find((u) => Address.toBech32(u.address) === Address.toBech32(address));
    if (utxo) genesisByAccount.set(i, utxo);
  });

  const cluster = await Cluster.make({
    clusterName: name,
    shelleyGenesis,
    conwayGenesis,
    kupo: { enabled: true, logLevel: 'Info' },
    ogmios: { enabled: true, logLevel: 'info' },
  });
  const ogmiosPort = cluster.ports.ogmios;
  if (ogmiosPort === undefined) throw new Error('The devnet has no Ogmios port.');

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await Cluster.stop(cluster);
    } finally {
      await Cluster.remove(cluster);
    }
  };

  try {
    await Cluster.start(cluster);
    await waitFor('Ogmios to answer queryNetwork/tip', () =>
      ogmiosCall<unknown>(ogmiosPort, 'queryNetwork/tip').then((tip) => (tip ? tip : null)),
    );
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    cluster,
    client: (accountIndex) => makeSeedClient(cluster, accountIndex),
    genesisUtxo: (accountIndex) => {
      const utxo = genesisByAccount.get(accountIndex);
      if (!utxo) throw new Error(`No genesis UTxO for account ${accountIndex}.`);
      return utxo;
    },
    ogmios: (method, params) => ogmiosCall(ogmiosPort, method, params),
    cli: async <T>(args: string[]) => {
      const command = ['cardano-cli', 'conway', ...args, '--socket-path', NODE_SOCKET, '--testnet-magic'];
      const output = await Container.execCommand(cluster.cardanoNode, [...command, String(shelleyGenesis.networkMagic)]);
      try {
        return JSON.parse(output) as T;
      } catch {
        throw new Error(`cardano-cli ${args.join(' ')} did not answer JSON: ${output}`);
      }
    },
    waitFor,
    stop,
  };
}
