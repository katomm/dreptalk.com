// What the review modal shows for the on-chain half of a governance action,
// built entirely on the client from the form state, the chain context the
// user is looking at and the epoch params the page already fetched.
//
// The point of building a synthetic Koios payload and feeding it to the very
// decoder the action page uses (decodeOnchainChanges) is that the preview
// cannot drift from the real page: one decoder, one card, one set of labels.
// The Markdown half goes through the server's /api/preview instead, because
// only the server has the sanitizing renderer.
//
// Bundle-safe leaf: onchain.ts and govActionFormState.ts are pure, the hash
// comes from blakejs, and nothing here reaches the CIP-108 canonicalizer.
import { decodeOnchainChanges, type OnchainChanges } from './onchain.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import {
  chosenPrev,
  effectivePrev,
  describeCommitteePanel,
  describeHardForkPanel,
  describeNewConstitutionPanel,
  type GovActionFormState,
} from './govActionFormState.js';
import type { PrevActionRef } from './prevAction.js';
import type { ActionContextResponse } from './actionContextHandler.js';
import type { EpochParamsRow } from '../koios/client.js';
import type { CardanoNetwork } from '../config/network.js';

/**
 * Stands in for the anchor URL of a NewConstitution document that has not been
 * published yet. Deliberately not a valid URL, so resolveAnchorUrl refuses it
 * and the preview shows it as text rather than as a link to nowhere.
 */
export const CONSTITUTION_PREVIEW_URL = 'ipfs://(assigned when you submit)';

/** The part of the form the preview reads. Narrower than the whole state: no wallet, no context. */
export type PreviewFormState = Pick<GovActionFormState, 'type' | 'metadata' | 'panels'>;

export interface PreviewModel {
  /** The on-chain changes card's content, decoded exactly as the action page decodes it. */
  onchain: OnchainChanges | null;
  /** Field names still standing between the form and a submittable action, in form order. */
  missing: string[];
  /** The one line the preview says about authorship. */
  authorLine: string;
}

/** The predecessor pointer as Koios writes it into a payload's first content slot. */
function prevSlot(prev: PrevActionRef | null): { txId: string; govActionIx: number } | null {
  return prev === null ? null : { txId: prev.txHashHex, govActionIx: prev.index };
}

/** The "<credType>-<hex>" key shape decodeOnchainChanges reads an added member out of. */
function addedKey(credential: { hashHex: string; isScript: boolean }): string {
  return `${credential.isScript ? 'scriptHash' : 'keyHash'}-${credential.hashHex}`;
}

/** The { keyHash } | { scriptHash } shape a removed member has on chain. */
function removedEntry(credential: { hashHex: string; isScript: boolean }): Record<string, string> {
  return credential.isScript ? { scriptHash: credential.hashHex } : { keyHash: credential.hashHex };
}

/**
 * The synthetic Koios `proposal_description` for the form as it stands, plus
 * the panel fields that are still missing. The payload shapes are the ones in
 * onchain.test.ts's fixtures, which were confirmed against real mainnet rows.
 */
function previewPayload(
  state: PreviewFormState,
  context: ActionContextResponse | null,
): { payload: { tag: string; contents: unknown[] }; missing: string[] } {
  const prev = prevSlot(effectivePrev(chosenPrev(state.type, state.panels), context));

  switch (state.type) {
    case 'InfoAction':
      return { payload: { tag: 'InfoAction', contents: [] }, missing: [] };

    case 'NoConfidence':
      return { payload: { tag: 'NoConfidence', contents: [prev] }, missing: [] };

    case 'HardForkInitiation': {
      const { payloadPart, missing } = describeHardForkPanel(state.panels.HardForkInitiation, context);
      return {
        // An unchosen version leaves the slot empty rather than inventing one,
        // so the card shows the active version and nothing after the arrow.
        payload: { tag: 'HardForkInitiation', contents: payloadPart ? [prev, payloadPart] : [prev] },
        missing,
      };
    }

    case 'NewConstitution': {
      const { payloadPart, missing } = describeNewConstitutionPanel(state.panels.NewConstitution, context);
      const text = payloadPart?.text ?? '';
      // Hashes exactly the bytes the document route would publish, so the hash
      // shown here is the hash that ends up on chain. Blank text has no
      // document to hash, so the row is left out instead of showing the hash
      // of an empty string.
      const dataHash = text.trim() ? bytesToHex(blake2b256(new TextEncoder().encode(text))) : null;
      return {
        payload: {
          tag: 'NewConstitution',
          contents: [
            prev,
            {
              anchor: { url: CONSTITUTION_PREVIEW_URL, dataHash },
              script: payloadPart?.scriptHashHex ?? null,
            },
          ],
        },
        missing,
      };
    }

    case 'UpdateCommittee': {
      const { payloadPart, missing } = describeCommitteePanel(state.panels.UpdateCommittee, context);
      const added: Record<string, number> = {};
      for (const member of payloadPart?.add ?? []) added[addedKey(member.credential)] = member.expiryEpoch;
      return {
        payload: {
          tag: 'UpdateCommittee',
          contents: [
            prev,
            (payloadPart?.remove ?? []).map(removedEntry),
            added,
            payloadPart?.quorum ?? null,
          ],
        },
        missing,
      };
    }
  }
}

/** The CIP-108 metadata fields, in the order the form shows them. */
const METADATA_FIELDS = [
  ['title', 'Title'],
  ['abstract', 'Abstract'],
  ['motivation', 'Motivation'],
  ['rationale', 'Rationale'],
] as const;

/**
 * Everything the review modal needs about the action itself, resolving
 * untouched defaults exactly as the panels resolve them (the chain root as
 * the previous action, the quorum and the guardrails hash in force).
 *
 * Never throws: a half-typed credential or a mistyped epoch is reported as a
 * missing field, and an incomplete form previews with the parts that are
 * readable. `missing` is ordered the way the form is read, top to bottom: the
 * type panel's fields, then the metadata, then the author name.
 */
export function previewModelFromForm(
  state: PreviewFormState,
  context: ActionContextResponse | null,
  epochParams: EpochParamsRow | null,
  network: CardanoNetwork,
): PreviewModel {
  const { payload, missing: panelMissing } = previewPayload(state, context);
  const onchain = decodeOnchainChanges(
    JSON.stringify(payload),
    epochParams ? JSON.stringify(epochParams) : null,
    network,
  );

  const metadata = state.metadata;
  const missing = [...panelMissing];
  for (const [key, label] of METADATA_FIELDS) {
    if (!metadata[key].trim()) missing.push(label);
  }

  const authorName = metadata.authorName.trim();
  const authored = metadata.signAsAuthor && authorName !== '';
  if (metadata.signAsAuthor && authorName === '') missing.push('Author name');

  return {
    onchain,
    missing,
    authorLine: authored
      ? `Author: ${authorName}, will be signed with your wallet key when you submit`
      : 'No author named',
  };
}
