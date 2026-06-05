import type { DrepInfo, AccountInfo } from '../koios/client';

// Minimal interface satisfied by createKoiosClient's return value.
// Using a structural interface keeps this module testable with fake clients.
export interface KoiosClient {
  drepInfo(drepId: string): Promise<DrepInfo | null>;
  accountInfo(stakeAddress: string): Promise<AccountInfo | null>;
  proposalsByReturnAddress(
    stakeAddress: string,
  ): Promise<Array<{ proposal_id: string; return_address: string; proposal_type: string }>>;
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

  const isDrep = info.registered && info.active;
  return { isDrep, active: info.active };
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
  const matches = all.filter((p) => p.return_address === stakeAddress);
  return {
    isProposer: matches.length > 0,
    proposalIds: matches.map((p) => p.proposal_id),
  };
}
