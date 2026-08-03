// Shared DRep wallet-connect flows: CIP-95 enable, network guard, DRep
// identity derivation, and per-flow verification. connectAsDrep (VotePanel,
// MultiVoteBar) preflights the registered-DRep status; connectVerifiedDrep
// (DrepSettings, DrepRetire) checks the wallet against the signed-in DRep id.
// One module so the flows cannot drift.
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import type { WalletApi as TxWalletApi } from '@/lib/governance/drepTx.js';
import { drepIdFromKeyHash } from '@/lib/cardano/identity.js';
import { blake2b224 } from '@/lib/crypto/blake.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import type { CardanoNetwork } from '@/lib/config/network.js';

// The enabled wallet api surface: CIP-30 tx methods + CIP-95 extension +
// getNetworkId for the network guard.
export type EnabledWalletApi = TxWalletApi & {
  getNetworkId(): Promise<number>;
  cip95?: { getPubDRepKey(): Promise<string> };
};

export interface DRepIdentity {
  drepId: string;
  drepKeyHash: Uint8Array;
}

/**
 * The connected wallet's DRep is not eligible to vote here (script credential,
 * or not a registered active DRep). Typed so the preflight's catch can tell
 * these apart from transient read failures without matching message text.
 */
export class DrepIneligibleError extends Error {}

/**
 * Connects a wallet as a key-credential DRep: enables with the CIP-95
 * extension, runs the network guard, derives the DRep key hash + bech32 id,
 * and preflights the on-chain DRep status via Koios. Throws an Error with a
 * user-facing message on any hard failure; a failed status READ falls through
 * (the wallet + chain remain the final authority at submit time).
 */
export async function connectAsDrep(
  rawWallet: { enable(opts?: { extensions: Array<{ cip: number }> }): Promise<unknown> },
  network: CardanoNetwork,
  hooks?: {
    onEnabled?: (api: EnabledWalletApi) => void;
    onChecking?: (identity: DRepIdentity) => void;
  },
): Promise<{ api: EnabledWalletApi; identity: DRepIdentity }> {
  const api = (await rawWallet.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;

  // Network guard: fail clearly before any tx is built.
  await assertWalletNetwork(api, network);

  // CIP-95 must be present to read the DRep key.
  if (!api.cip95 || typeof api.cip95.getPubDRepKey !== 'function') {
    throw new Error(
      'This wallet does not support CIP-95, which is required to vote as a DRep. Please use a DRep-capable wallet (e.g. Lace, Eternl, Typhon).',
    );
  }

  hooks?.onEnabled?.(api);

  // Derive DRep key hash + bech32 id.
  const pubKeyHex = await api.cip95.getPubDRepKey();
  const pubKeyBytes = hexToBytes(pubKeyHex);
  const drepKeyHash = blake2b224(pubKeyBytes);
  const identity: DRepIdentity = { drepKeyHash, drepId: drepIdFromKeyHash(drepKeyHash) };

  hooks?.onChecking?.(identity);

  // Verify this is a registered, active, key-credential DRep before showing
  // the vote form. A Koios or network failure falls through so a legitimately
  // registered DRep is never blocked by a transient read error.
  try {
    const res = await fetchWithTimeout('/api/koios/drep_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _drep_ids: [identity.drepId] }),
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{
        has_script?: boolean;
        drep_status?: string;
        active?: boolean;
      }>;
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (row) {
        if (row.has_script === true) {
          throw new DrepIneligibleError(
            'Your wallet uses a script-credential DRep, which cannot sign votes directly. Only key-credential DReps can vote here.',
          );
        }
        if (row.drep_status !== 'registered' || row.active !== true) {
          throw new DrepIneligibleError(
            "Your wallet's DRep key is not a registered, active DRep. Register as a DRep before voting.",
          );
        }
      }
      // Absent row: never seen on-chain OR a brand-new DRep whose sync has not
      // landed in Koios yet, so fall through rather than block.
    }
    // Non-ok response: fall through and let the submit step be the final gate.
  } catch (err) {
    // Rethrow our own eligibility errors; swallow read failures only.
    if (err instanceof DrepIneligibleError) throw err;
  }

  return { api, identity };
}

/** True when the wallet-derived drep id matches the session's. Pure; case-insensitive bech32 compare. */
export function identityMatches(walletDrepId: string, expectedDrepId: string): boolean {
  return walletDrepId.toLowerCase() === expectedDrepId.toLowerCase();
}

/**
 * Connects a wallet as the signed-in DRep for the manage flows (settings
 * update, retire): CIP-95 enable (skipped when a still-enabled api is passed;
 * enable() is idempotent but each call is an extension IPC round trip), network
 * guard, DRep identity derivation, and the identity check against the
 * session's DRep id. Throws an Error with a user-facing message on any
 * failure. No Koios status preflight here: the manage flows act on an already
 * signed-in DRep, and the wallet + chain gate the final transaction.
 */
export async function connectVerifiedDrep(args: {
  rawWallet: { enable(opts?: { extensions: Array<{ cip: number }> }): Promise<unknown> };
  network: CardanoNetwork;
  expectedDrepId: string;
  cachedApi?: EnabledWalletApi | null;
}): Promise<{ api: EnabledWalletApi; drepKeyHash: Uint8Array }> {
  const api =
    args.cachedApi ?? ((await args.rawWallet.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi);

  // Network guard runs on the cached api too: the wallet's network can change
  // between actions.
  await assertWalletNetwork(api, args.network);

  if (!api.cip95 || typeof api.cip95.getPubDRepKey !== 'function') {
    throw new Error(
      'This wallet does not support CIP-95, which is required to manage a DRep. Please use a DRep-capable wallet (e.g. Lace, Eternl, Typhon).',
    );
  }

  const pubKeyHex = await api.cip95.getPubDRepKey();
  const drepKeyHash = blake2b224(hexToBytes(pubKeyHex));
  const drepId = drepIdFromKeyHash(drepKeyHash);

  if (!identityMatches(drepId, args.expectedDrepId)) {
    throw new Error(
      `This wallet belongs to a different DRep (${drepId}). Please connect the wallet you signed in with.`,
    );
  }

  return { api, drepKeyHash };
}
