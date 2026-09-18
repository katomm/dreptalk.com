/// <reference types="@cloudflare/workers-types" />
// GET /api/gov-action/context: live ledger context for the /ga/new type
// selector. A chained Conway governance action (NoConfidence, UpdateCommittee,
// NewConstitution, HardForkInitiation) needs the purpose chain's current root
// and open rows (prevAction.ts), plus type-specific context read straight
// from Koios at request time: the protocol version for a hard fork, the
// sitting committee and its quorum for a committee action, the constitution
// script hash for a new constitution. InfoAction is unchained and gets only
// the current epoch.
//
// Mirrors infoActionMetadataHandler.ts's dependency-injection style, but is
// itself the single gate call site (the context policy needs no JWT and a
// looser rate limit, so it cannot share the metadata route's call site).
import type { NetworkConfig } from '@/lib/config/network.js';
import { jsonResponse, currentNetwork } from '@/lib/api/response.js';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import {
  chainForType,
  pickLastEnacted,
  openInChain,
  formatGovActionKey,
  type GovActionFormType,
  type GovActionRef,
} from './prevAction.js';
import { parseHardForkVersion, decodeOnchainChanges } from './onchain.js';
import { getGovernanceActionTitlesByIds } from '../db/governance.js';
import type { ProposalListRow, EpochParamsRow, CommitteeMember } from '../koios/client.js';

const GOV_ACTION_FORM_TYPES: readonly GovActionFormType[] = [
  'NoConfidence',
  'HardForkInitiation',
  'NewConstitution',
  'UpdateCommittee',
  'InfoAction',
];

function isGovActionFormType(value: string | null): value is GovActionFormType {
  return value !== null && (GOV_ACTION_FORM_TYPES as readonly string[]).includes(value);
}

// Subset of the full Koios client this handler needs, small enough to mock
// cleanly in tests without pulling in createKoiosClient's HTTP plumbing.
export interface ActionContextKoios {
  tip(): Promise<{ epoch_no: number }>;
  epochParams(): Promise<EpochParamsRow | null>;
  lastRatifiedProposal(types: readonly string[]): Promise<ProposalListRow[]>;
  openProposals(types: readonly string[], limit?: number): Promise<ProposalListRow[]>;
  // One /committee_info fetch shared by members and quorum (see
  // koios/client.ts's committeeContext), so this handler never fetches it twice.
  committeeContext(): Promise<{
    members: CommitteeMember[];
    quorum: { numerator: number; denominator: number } | null;
  }>;
}

export interface ActionContextHandlerDeps {
  koios: ActionContextKoios;
  network?: NetworkConfig;
  env?: Cloudflare.Env;
}

export interface ActionContextResponse {
  epoch: number;
  prev?: { lastEnacted: GovActionRef | null; open: GovActionRef[] };
  protocolVersion?: { major: number; minor: number };
  committee?: {
    members: { coldHex: string | null; hasScript: boolean; expirationEpoch: number | null }[];
    quorum: { numerator: number; denominator: number } | null;
    maxTermLength: number | null;
  };
  constitution?: { scriptHash: string | null };
}

function toGovActionRef(row: ProposalListRow, title: string | null): GovActionRef {
  return {
    txHash: row.proposal_tx_hash,
    index: row.proposal_index,
    id: row.proposal_id,
    type: row.proposal_type,
    title,
    proposedEpoch: row.proposed_epoch ?? 0,
    version: parseHardForkVersion(row.proposal_description) ?? undefined,
  };
}

interface PrevContextResult {
  context: { lastEnacted: GovActionRef | null; open: GovActionRef[] };
  // The raw last-enacted row (with its untouched proposal_description), kept
  // alongside the built GovActionRef so the NewConstitution branch can read
  // the on-chain payload without a second Koios request for the same chain.
  lastEnactedRow: ProposalListRow | null;
}

async function buildPrevContext(
  koios: ActionContextKoios,
  db: D1Database,
  chain: readonly string[],
): Promise<PrevContextResult> {
  const [ratifiedRows, openRowsRaw] = await Promise.all([
    koios.lastRatifiedProposal(chain),
    koios.openProposals(chain),
  ]);

  // pickLastEnacted/openInChain take the structural ChainRow type from
  // prevAction.ts; ProposalListRow satisfies it, and the values returned are
  // the exact same row objects (never rebuilt), so the cast back is safe and
  // keeps proposal_description available for the hard-fork version and
  // constitution script-hash reads below.
  const lastEnactedRow = pickLastEnacted(ratifiedRows) as ProposalListRow | null;
  const openRows = openInChain(openRowsRaw) as ProposalListRow[];

  const allRows = lastEnactedRow ? [lastEnactedRow, ...openRows] : openRows;
  const ids = allRows.map((r) => formatGovActionKey({ txHashHex: r.proposal_tx_hash, index: r.proposal_index }));
  const titles = await getGovernanceActionTitlesByIds(db, ids);

  const withTitle = (row: ProposalListRow): GovActionRef => {
    const key = formatGovActionKey({ txHashHex: row.proposal_tx_hash, index: row.proposal_index });
    return toGovActionRef(row, titles.get(key) ?? null);
  };

  return {
    context: {
      lastEnacted: lastEnactedRow ? withTitle(lastEnactedRow) : null,
      open: openRows.map(withTitle),
    },
    lastEnactedRow,
  };
}

/**
 * Handles GET /api/gov-action/context: the single gate call site for the
 * context policy (no JWT, 30/min). Never throws on a well-formed request;
 * an unrecognized `type` query param is the only 400.
 */
export async function handleActionContext(
  ctx: { request: Request; locals: App.Locals },
  deps: ActionContextHandlerDeps,
): Promise<Response> {
  const net = deps.network ?? currentNetwork();
  const gate = await gateGovActionRequest(ctx, GOV_ACTION_RATE_POLICIES.context, {
    network: net,
    env: deps.env,
  });
  if (gate instanceof Response) return gate;
  const db = gate.db;

  const url = new URL(ctx.request.url);
  const typeParam = url.searchParams.get('type');
  if (!isGovActionFormType(typeParam)) return jsonResponse({ error: 'invalid type' }, 400);
  const type = typeParam;

  const tip = await deps.koios.tip();
  const response: ActionContextResponse = { epoch: tip.epoch_no };

  const chain = chainForType(type);
  let prevResult: PrevContextResult | null = null;
  if (chain) {
    prevResult = await buildPrevContext(deps.koios, db, chain);
    response.prev = prevResult.context;
  }

  if (type === 'HardForkInitiation') {
    const params = await deps.koios.epochParams();
    if (params?.protocol_major != null) {
      response.protocolVersion = { major: params.protocol_major, minor: params.protocol_minor ?? 0 };
    }
  }

  if (type === 'NoConfidence' || type === 'UpdateCommittee') {
    const [committeeCtx, params] = await Promise.all([deps.koios.committeeContext(), deps.koios.epochParams()]);
    response.committee = {
      members: committeeCtx.members.map((m) => ({
        coldHex: m.cc_cold_hex,
        hasScript: m.cc_cold_has_script === true,
        expirationEpoch: m.expiration_epoch,
      })),
      quorum: committeeCtx.quorum,
      maxTermLength: params?.committee_max_term_length ?? null,
    };
  }

  if (type === 'NewConstitution') {
    let scriptHash: string | null = null;
    const raw = prevResult?.lastEnactedRow;
    if (raw?.proposal_description != null) {
      const changes = decodeOnchainChanges(JSON.stringify(raw.proposal_description), null, net.network);
      if (changes?.kind === 'constitution') scriptHash = changes.scriptHash;
    }
    response.constitution = { scriptHash };
  }

  return jsonResponse(response, 200, { 'cache-control': 'no-store' });
}
