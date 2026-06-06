import type { DrepInfo, Proposal } from '../koios/client';

// Minimal interface satisfied by createKoiosClient's return value.
// Using a structural interface keeps this module testable with fake clients.
export interface KoiosClient {
  drepInfo(drepId: string): Promise<DrepInfo | null>;
  proposalsByReturnAddress(stakeAddress: string): Promise<Proposal[]>;
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
