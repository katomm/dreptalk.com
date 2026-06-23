---
title: "How to write a Cardano DRep vote rationale"
description: "How a DRep writes a clear, useful rationale for a governance vote, what to include, and how it is published as on-chain metadata following the CIP-100 standard."
cardLabel: "Writing a vote rationale"
category: "For DReps"
order: 2
updated: 2026-06-23
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

You cast your vote with the rationale through your wallet or governance tooling, the same place you submit the vote itself. The rationale travels with the vote as a metadata document, following the community standard known as **CIP-100**. In practice, most rationales use a single comment field within that standard. Once submitted, the metadata is permanent and publicly readable from the chain; anyone can look it up via a governance explorer, and DRepTalk shows it on your profile and on the governance action.

You do not need to understand CIP-100 in detail to write a good rationale. The tooling handles the formatting. What matters is the content you put in it.

## Related

- [Governance action types](/help/governance-action-types)
- [Managing your DRep](/help/managing-your-drep)
