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
  GOV_ACTION_FORM_TYPES,
  type GovActionFormType,
  type GovActionRef,
} from './prevAction.js';
import { parseHardForkVersion, parseProposalPolicyHash, decodeOnchainChanges } from './onchain.js';
import { getGovernanceActionTitlesByIds } from '../db/governance.js';
import type { ProposalListRow, EpochParamsRow, CommitteeMember } from '../koios/client.js';

// Proposal types whose ledger-accepted policy hash witnesses the constitution's
// guardrails script in force, for chains where no NewConstitution action has
// ever been ratified (see parseProposalPolicyHash).
const POLICY_HASH_WITNESS_TYPES = ['ParameterChange', 'TreasuryWithdrawals'] as const;

/**
 * The guardrails script hash the constitution in force enforces, picked from
 * whichever of the two ratified rows is newer: a NewConstitution action (the
 * hash it set directly) or a ParameterChange/TreasuryWithdrawals action (the
 * policy hash the ledger required it to be submitted with). A chain such as
 * preprod's, where the constitution came from the Conway bootstrap and no
 * NewConstitution was ever ratified, only has the second source. Missing or
 * unparsable sources fall back to the other. Both missing, or a tie, return
 * whichever source is present, preferring the constitution row.
 */
function pickConstitutionScriptHash(
  constitutionRow: ProposalListRow | null,
  policyRow: ProposalListRow | null,
  network: NetworkConfig['network'],
): string | null {
  const constitutionScript =
    constitutionRow?.proposal_description != null
      ? (() => {
          const changes = decodeOnchainChanges(JSON.stringify(constitutionRow.proposal_description), null, network);
          return changes?.kind === 'constitution' ? changes.scriptHash : null;
        })()
      : null;
  const policyHash =
    policyRow?.proposal_description != null ? parseProposalPolicyHash(policyRow.proposal_description) : null;

  if (constitutionScript !== null && policyHash !== null) {
    const constitutionEpoch = constitutionRow?.ratified_epoch ?? null;
    const policyEpoch = policyRow?.ratified_epoch ?? null;
    if (policyEpoch !== null && (constitutionEpoch === null || policyEpoch > constitutionEpoch)) {
      return policyHash;
    }
    return constitutionScript;
  }
  return constitutionScript ?? policyHash;
}

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

  // Both helpers are generic over the structural ChainRow type from
  // prevAction.ts, so a ProposalListRow in gives a ProposalListRow out and
  // proposal_description stays available for the hard-fork version and
  // constitution script-hash reads below.
  const lastEnactedRow = pickLastEnacted(ratifiedRows);
  const openRows = openInChain(openRowsRaw);

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
 * context policy (no JWT, 30/min). An unrecognized `type` query param is a
 * 400. Every Koios read below can reject (upstream 5xx, timeout, network
 * failure), which is guarded with a try/catch so a Koios outage answers a
 * controlled 503 instead of throwing past the route into Astro's HTML error
 * page.
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

  try {
    // The tip, the purpose chain and the type-specific reads are independent
    // of each other, so all of them are started before anything is awaited and
    // the request costs one round trip rather than three in a row. Which ones
    // exist depends on the type, so the branching happens on the promises.
    const chain = chainForType(type);
    const tipPromise = deps.koios.tip();
    const prevPromise = chain ? buildPrevContext(deps.koios, db, chain) : null;
    const needsEpochParams = type === 'HardForkInitiation' || type === 'NoConfidence' || type === 'UpdateCommittee';
    const paramsPromise = needsEpochParams ? deps.koios.epochParams() : null;
    const committeePromise =
      type === 'NoConfidence' || type === 'UpdateCommittee' ? deps.koios.committeeContext() : null;
    // preprod's constitution came from the Conway bootstrap with no
    // NewConstitution ever ratified, so the last ratified ParameterChange or
    // TreasuryWithdrawals is the only witness of the guardrails script in
    // force there. Only fetched for the type that needs it.
    const policyRowPromise =
      type === 'NewConstitution' ? deps.koios.lastRatifiedProposal(POLICY_HASH_WITNESS_TYPES) : null;

    const [tip, prevResult, params, committeeCtx, policyRows] = await Promise.all([
      tipPromise,
      prevPromise,
      paramsPromise,
      committeePromise,
      policyRowPromise,
    ]);

    const response: ActionContextResponse = { epoch: tip.epoch_no };
    if (prevResult) response.prev = prevResult.context;

    if (type === 'HardForkInitiation' && params?.protocol_major != null) {
      response.protocolVersion = { major: params.protocol_major, minor: params.protocol_minor ?? 0 };
    }

    if (committeeCtx) {
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
      const constitutionRow = prevResult?.lastEnactedRow ?? null;
      const policyRow = policyRows?.[0] ?? null;
      response.constitution = { scriptHash: pickConstitutionScriptHash(constitutionRow, policyRow, net.network) };
    }

    return jsonResponse(response, 200, { 'cache-control': 'no-store' });
  } catch (err: unknown) {
    // Koios is a third-party upstream: a 5xx, a timeout, or a dropped
    // connection is routine, not a bug in this handler. Log it and answer
    // with the honest status instead of letting it surface as a 500.
    console.error('[gov-action] context: koios read failed', err);
    return jsonResponse({ error: 'service unavailable' }, 503, { 'cache-control': 'no-store' });
  }
}
