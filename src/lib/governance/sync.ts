// Governance-action sync: discover on-chain actions via Koios and open one
// system thread per new action. Idempotent: actions already in D1 are skipped.
// A failure on one action (bad anchor, etc.) is isolated and does not abort the
// run. Tallies, lifecycle status, and vote badges are a later sync phase.

import type { ProposalListRow } from '../koios/client.js';
import type { CardanoNetwork } from '../config/network.js';
import { cardanoscanBase } from '../config/network.js';
import { fetchAnchorMetadata } from './metadata.js';
import { renderMarkdown } from '../markdown.js';
import { createTopic } from '../db/forum.js';
import { getKnownActionIds, buildInsertGovernanceAction } from '../db/governance.js';
import { GOVERNANCE_CATEGORY_SLUG } from '../../../config/categories.js';

// System author for gov-sync-created threads.
export const GOV_SYNC_AUTHOR = 'gov-sync';

export interface SyncResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
}

export interface GovSyncDeps {
  koios: { proposalList(limit?: number): Promise<ProposalListRow[]> };
  db: D1Database;
  network: CardanoNetwork;
  now: number;
  /** Slug-suffix source (injected for deterministic tests). */
  rand: () => string;
  /** Anchor fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
}

/** "TreasuryWithdrawals" -> "Treasury Withdrawals". */
function readableType(type: string): string {
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function formatDeposit(lovelace: string | null | undefined): string | null {
  if (!lovelace) return null;
  const n = Number(lovelace);
  if (!Number.isFinite(n)) return null;
  return `${(n / 1_000_000).toLocaleString('en-US')} ADA`;
}

function explorerUrl(network: CardanoNetwork, proposalId: string): string {
  // Cardanoscan has a live preprod instance with stable /govAction routes;
  // GovTool's preprod host was unreliable.
  return `${cardanoscanBase(network)}/govAction/${proposalId}`;
}

/**
 * Composes the first post as Markdown. Everything (including the untrusted
 * abstract and return address) is rendered through renderMarkdown, whose xss
 * allowlist is the backstop against injection.
 */
function composeFirstPostMd(p: ProposalListRow, abstract: string | null, network: CardanoNetwork): string {
  const lines: string[] = [
    `**On-chain governance action** (${readableType(p.proposal_type)}).`,
    '',
    abstract || 'No abstract was provided in the action metadata.',
    '',
  ];
  if (p.return_address) lines.push(`- Proposer return address: \`${p.return_address}\``);
  const dep = formatDeposit(p.deposit);
  if (dep) lines.push(`- Deposit: ${dep}`);
  if (p.proposed_epoch != null) lines.push(`- Submitted: epoch ${p.proposed_epoch}`);
  if (p.expiration != null) lines.push(`- Expires: epoch ${p.expiration}`);
  lines.push('', `[View on Cardanoscan](${explorerUrl(network, p.proposal_id)})`);
  return lines.join('\n');
}

export async function syncGovernanceActions(deps: GovSyncDeps): Promise<SyncResult> {
  const { koios, db, network, now, rand, fetchImpl } = deps;

  const proposals = await koios.proposalList();
  const known = await getKnownActionIds(db);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of proposals) {
    const id = `${p.proposal_tx_hash}#${p.proposal_index}`;
    if (known.has(id)) {
      skipped++;
      continue;
    }

    try {
      // Fetch + verify the off-chain anchor when present; tolerate failures.
      const anchor =
        p.meta_url && p.meta_hash
          ? await fetchAnchorMetadata(p.meta_url, p.meta_hash, { fetchImpl })
          : { status: 'no-anchor' as const, metadata: null };

      const meta = anchor.metadata;
      // Fallback title includes the proposal index so multiple actions in one
      // transaction (same tx hash) get distinct titles.
      const title =
        meta?.title || `${readableType(p.proposal_type)} (${p.proposal_tx_hash.slice(0, 8)}#${p.proposal_index})`;

      const bodyMd = composeFirstPostMd(p, meta?.abstract ?? null, network);
      const bodyHtml = renderMarkdown(bodyMd);

      // The governance_actions row is committed in the same atomic batch as the
      // topic and first post, so a partial write can never leave an orphan topic
      // (which the next run would re-create as a duplicate).
      await createTopic(db, {
        categorySlug: GOVERNANCE_CATEGORY_SLUG,
        authorId: GOV_SYNC_AUTHOR,
        title,
        bodyMd,
        bodyHtml,
        source: 'governance',
        now,
        rand: rand(),
        batchWith: (topicId) => [
          buildInsertGovernanceAction(db, {
            id,
            proposalId: p.proposal_id,
            type: p.proposal_type,
            title: meta?.title ?? null,
            abstract: meta?.abstract ?? null,
            rationaleHtml: meta?.rationaleHtml ?? null,
            anchorUrl: p.meta_url ?? null,
            anchorHash: p.meta_hash ?? null,
            anchorStatus: anchor.status,
            returnAddress: p.return_address ?? null,
            deposit: p.deposit ?? null,
            submittedEpoch: p.proposed_epoch ?? null,
            expiryEpoch: p.expiration ?? null,
            topicId,
            now,
          }),
        ],
      });

      created++;
    } catch {
      failed++;
    }
  }

  return { total: proposals.length, created, skipped, failed };
}
