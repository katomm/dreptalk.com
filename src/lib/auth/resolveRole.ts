import type { DrepInfo, Proposal, PoolCalidusKeyRow, CommitteeMember, ScriptInfo, AccountInfo } from '../koios/client';
import { parseDrepId } from '../cardano/identity.js';
import { parseNativeScriptJson, collectSigKeyHashes, nativeScriptHash } from '../cardano/nativeScript.js';

// Minimal interface satisfied by createKoiosClient's return value.
// Using a structural interface keeps this module testable with fake clients.
export interface KoiosClient {
  drepInfo(drepId: string): Promise<DrepInfo | null>;
  proposalsByReturnAddress(stakeAddress: string): Promise<Proposal[]>;
  poolCalidusKey(calidusPubKeyHex: string): Promise<PoolCalidusKeyRow | null>;
  committeeInfo(): Promise<CommitteeMember[]>;
  scriptInfo(scriptHash: string): Promise<ScriptInfo | null>;
  // Used by the delegator login hook to resolve the follow row (src/lib/delegation/refresh.js).
  accountInfo(stakeAddress: string): Promise<AccountInfo | null>;
  accountInfoBatch(stakeAddresses: string[]): Promise<AccountInfo[]>;
}

export interface DRepResolution {
  isDrep: boolean;
  active: boolean;
  reason?: string;
}

export interface ProposerResolution {
  isProposer: boolean;
  proposalIds: string[];
}

export interface SpoResolution {
  isSpo: boolean;
  poolId?: string;
  reason?: string;
}

export interface CcResolution {
  isCc: boolean;
  ccHotId?: string;
  ccColdId?: string;
  reason?: string;
}

/**
 * Determines whether a given drep_id belongs to an active, non-script DRep.
 * Script DReps are rejected in v1 (reason: 'script').
 */
export async function resolveDRep(
  koios: KoiosClient,
  drepId: string,
): Promise<DRepResolution> {
  const info = await koios.drepInfo(drepId);

  if (!info) {
    return { isDrep: false, active: false };
  }

  if (info.has_script) {
    return { isDrep: false, active: info.active, reason: 'script' };
  }

  if (info.drep_status !== 'registered') {
    return { isDrep: false, active: info.active, reason: 'not registered' };
  }

  if (!info.active) {
    return { isDrep: false, active: false, reason: 'inactive' };
  }

  return { isDrep: true, active: true };
}

/**
 * Determines whether a stake address has submitted any governance proposals.
 * Uses exact case-sensitive bech32 match on return_address.
 */
export async function resolveProposer(
  koios: KoiosClient,
  stakeAddress: string,
): Promise<ProposerResolution> {
  const all = await koios.proposalsByReturnAddress(stakeAddress);
  // defense in depth: re-check the server-side eq. filter so a misbehaving or cached Koios response cannot grant proposer status
  const matches = all.filter((p) => p.return_address === stakeAddress);
  return {
    isProposer: matches.length > 0,
    proposalIds: matches.map((p) => p.proposal_id),
  };
}

/**
 * Determines whether a raw Ed25519 Calidus public key (hex) belongs to an
 * active stake pool. Koios already enforces the CIP-151 highest-nonce and
 * revocation rules (only the current valid key is returned with registered:true);
 * we additionally require the pool to be registered and re-check, defense in
 * depth, that the returned key equals the one we queried. Match is
 * case-insensitive on the hex.
 */
export async function resolveSpo(
  koios: KoiosClient,
  calidusPubKeyHex: string,
): Promise<SpoResolution> {
  const want = calidusPubKeyHex.toLowerCase();
  const row = await koios.poolCalidusKey(want);

  if (!row) {
    return { isSpo: false };
  }
  // defense in depth: a misbehaving or cached Koios response whose calidus_pub_key
  // does not match the queried key must not grant SPO status.
  if (row.calidus_pub_key.toLowerCase() !== want) {
    return { isSpo: false, reason: 'pubkey mismatch' };
  }
  if (!row.registered) {
    return { isSpo: false, reason: 'revoked' };
  }
  if (row.pool_status !== 'registered') {
    return { isSpo: false, reason: 'pool not registered' };
  }

  return { isSpo: true, poolId: row.pool_id_bech32 };
}

/**
 * Determines whether a CC hot key-hash (hex, blake2b-224 of the hot pubkey)
 * belongs to an authorized, key-based constitutional committee member. Script
 * (native-script) hot credentials are rejected in v1. Match is case-insensitive.
 */
export async function resolveCc(
  koios: KoiosClient,
  hotKeyHashHex: string,
): Promise<CcResolution> {
  const want = hotKeyHashHex.toLowerCase();
  const members = await koios.committeeInfo();

  const match = members.find(
    (m) =>
      m.status === 'authorized' &&
      m.cc_hot_has_script === false &&
      m.cc_hot_hex?.toLowerCase() === want,
  );

  if (!match) {
    return { isCc: false };
  }

  // Defense in depth: an authorized member must expose at least one credential id
  // to serve as the stable account identity. Reject rather than mint a session
  // with no id (which would otherwise fail later in upsertUserFromAuth).
  if (!match.cc_cold_id && !match.cc_hot_id) {
    return { isCc: false, reason: 'no credential id' };
  }

  return {
    isCc: true,
    ccHotId: match.cc_hot_id ?? undefined,
    ccColdId: match.cc_cold_id ?? undefined,
  };
}

export interface ScriptDRepResolution {
  isMember: boolean;
  active: boolean;
  reason?: string;
}

/**
 * Determines whether candidateKeyHashHex (blake2b-224 of the signer's pubkey)
 * is an authorized signer of an active native-script DRep. Verifies the drep is
 * a registered, active script drep, fetches its native script from Koios,
 * re-hashes it to bind the returned script to the credential (defense in depth),
 * and checks membership against the script's sig leaves.
 */
export async function resolveScriptDRep(
  koios: KoiosClient,
  drepId: string,
  candidateKeyHashHex: string,
): Promise<ScriptDRepResolution> {
  // Check the id form first: a key-credential DRep id (header 0x22) entered in
  // the script field is the common mistake, and it must yield the actionable
  // "not a script id" reason whether or not it is registered (no Koios call
  // needed to know it is the wrong kind).
  const parsed = parseDrepId(drepId);
  if (!parsed || parsed.kind !== 'script') return { isMember: false, active: false, reason: 'not a script id' };

  const info = await koios.drepInfo(drepId);
  if (!info) return { isMember: false, active: false, reason: 'not found' };
  if (!info.has_script) return { isMember: false, active: info.active, reason: 'not a script drep' };
  if (info.drep_status !== 'registered') return { isMember: false, active: info.active, reason: 'not registered' };
  if (!info.active) return { isMember: false, active: false, reason: 'inactive' };

  const scriptData = await koios.scriptInfo(parsed.hashHex);
  if (!scriptData) return { isMember: false, active: info.active, reason: 'script not found' };

  const native = parseNativeScriptJson(scriptData.value);
  if (!native) return { isMember: false, active: info.active, reason: 'unsupported script' };

  if (nativeScriptHash(native) !== parsed.hashHex.toLowerCase()) {
    return { isMember: false, active: info.active, reason: 'script hash mismatch' };
  }

  if (!collectSigKeyHashes(native).has(candidateKeyHashHex.toLowerCase())) {
    return { isMember: false, active: info.active, reason: 'not a signer' };
  }
  return { isMember: true, active: info.active };
}
