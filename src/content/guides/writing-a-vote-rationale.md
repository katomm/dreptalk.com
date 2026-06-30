---
title: "How to write a Cardano DRep vote rationale"
description: "How a DRep writes a clear, useful rationale for a governance vote, what to include, and how it is published as a CIP-100 metadata document linked to the vote on-chain."
cardLabel: "Writing a vote rationale"
category: "For DReps"
order: 2
updated: 2026-06-24
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

The document does not live on the chain. What your vote records on-chain is a link to the document and a fingerprint (a hash) of its exact contents. DRepTalk hosts the document and serves it at a web address that is itself that fingerprint. Two things follow:

- **It cannot be quietly changed.** The address is derived from the contents, so any edit would be a different document at a different address and would no longer match the fingerprint on the chain. Your rationale is fixed the moment you vote.
- **Its availability depends on the host.** We host it for you, so publishing a rationale is one step, no IPFS or personal server to run. The tradeoff is that the document lives on DRepTalk: if this site ever went away, its web address would stop resolving, though the fingerprint on the chain stays valid forever, so the exact document can be verified and re-hosted by anyone who kept a copy. Some DReps prefer to self-host on IPFS for that reason; we host it for you to keep voting simple. Either way, the chain guarantees what you committed to, not where it is stored.

You do not need to understand CIP-100 to write a good rationale. What matters is the content you put in it.

## Related

- [Governance action types](/help/governance-action-types)
- [Managing your DRep](/help/managing-your-drep)
- [Data freshness](/help/data-freshness)
