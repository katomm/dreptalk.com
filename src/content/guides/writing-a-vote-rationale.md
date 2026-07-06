---
title: "How to write a Cardano DRep vote rationale"
description: "How a DRep writes a clear, useful rationale for a governance vote, what to include, and how it is published as a CIP-100 metadata document linked to the vote on-chain."
cardLabel: "Writing a vote rationale"
category: "For DReps"
order: 2
updated: 2026-07-06
---

A vote rationale is a short written explanation of why you voted the way you did on a governance action. It is attached to your vote as metadata so your delegators and the broader community can see your reasoning. Writing one is not mandatory, but it is good practice: delegators choose you because they trust your judgment, and a rationale shows that judgment transparently.

## Why it matters

A rationale does three things. First, it builds trust with your delegators. They cannot vote themselves and are counting on you to act in their interest; explaining your position closes that accountability gap. Second, it creates a public record. On-chain governance is a long game, and a trail of reasoned votes tells future delegators something meaningful about how you operate. Third, it helps the community weigh the action. A well-argued rationale from a known DRep can sharpen the debate and surface considerations others may have missed.

## What to include

A useful rationale answers the obvious question: why this vote? It does not need to be long. Cover these points:

- **Your position.** State clearly whether you voted Yes, No, or Abstain, and name the action you are responding to.
- **Your key reasons.** Two or three concrete reasons carry more weight than a vague paragraph. Be specific to this action, not governance in general.
- **Concerns or conditions.** If you voted Yes despite reservations, or Abstain because information was missing, say so. Conditional or reluctant votes are worth explaining.
- **Supporting links.** If there was a forum discussion, a technical review, or a constitutional analysis that informed your view, link to it. Let readers follow your reasoning.

Plain language is better than jargon. Write for a delegator who follows Cardano but is not a protocol expert.

## A simple structure

If you are not sure where to start, this outline works for most rationales:

1. One sentence stating your vote and naming the action.
2. Two or three short paragraphs giving your reasons.
3. Any reservations or conditions, if relevant.
4. Links to discussion or evidence, if you have them.

That is enough. Most published rationales are a paragraph or two. Longer is not better; clearer is.

## How it is published

When you vote with a rationale on DRepTalk, you write it in the editor and your wallet submits it together with the vote. The rationale is a small document in the community metadata standard **CIP-100**; in practice most rationales use a single comment field, and the editor formats it for you.

The document does not live on the chain. What your vote records on-chain is a link to the document and a fingerprint (a hash) of its exact contents. DRepTalk hosts the document and serves it at a web address that is itself that fingerprint. Here is a real one, published through DRepTalk:

[`dreptalk.com/vote-rationale/30e507c6…eec6eb61.json`](https://dreptalk.com/vote-rationale/30e507c64f300ad90187044b9b27dfa7244de3a42b15159e506eb5cfeec6eb61.json)

The long file name is the document's blake2b-256 hash, the same value recorded with the vote on the chain. Two things follow from addressing a document by its own fingerprint:

- **It cannot be quietly changed.** Any edit would be a different document at a different address, and it would no longer match the fingerprint on-chain. Your rationale is fixed the moment you vote.
- **Its availability depends on the host.** DRepTalk serves the document today. If this site ever went away, that web address would stop resolving, though the fingerprint on the chain stays valid forever, so anyone who kept a copy can verify the exact document and re-host it.

## What about IPFS?

Many DReps publish rationales on IPFS, so you might expect DRepTalk to do the same. We deliberately host the document ourselves instead: publishing stays one step at vote time, with no pinning service or personal server to run. The guarantee people look to IPFS for, that content cannot change behind an address, comes from the fingerprint either way; an IPFS address and a DRepTalk address are both just places the bytes live, and the chain holds the hash that proves them.

IPFS is not automatically permanent, either: a file there lives only as long as some node keeps pinning it, so it faces the same availability question as any host, just spread across whoever chooses to pin. Whichever host serves it, the chain guarantees what you committed to, not where it is stored.

You do not need to understand CIP-100 to write a good rationale. What matters is the content you put in it.

## Sharing your rationale in the discussion

Your rationale is always recorded on-chain with your vote and shown on the action's Positions tab, whichever way you vote. Separately, when you submit a vote with a rationale, a checkbox lets you also post a copy of it into the action's discussion thread, so other DReps and delegators can respond to it there.

That cross-post is optional and off by default. Leave the box unchecked and your rationale stays on the Positions tab only; check it and a frozen copy also appears in the discussion. The discussion copy is tied to your on-chain vote and cannot be edited. If you later re-vote with the box unchecked, the discussion copy is removed again.

## Related

- [Governance action types](/help/governance-action-types)
- [Managing your DRep](/help/managing-your-drep)
- [Data freshness](/help/data-freshness)
