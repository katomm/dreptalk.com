---
title: "How to vote on governance actions as an SPO"
description: "How a stake pool operator votes on Cardano governance actions: which action types an SPO vote counts on, what happens when a pool does not vote, why the pool cold key signs, and which tools to use."
cardLabel: "Voting as an SPO"
category: "Understanding governance"
order: 6
updated: 2026-09-02
faqs:
  - q: "Can I cast my pool's vote on DRepTalk?"
    a: "No. DRepTalk builds votes only for DReps, signed in their own wallet. A pool vote must be witnessed by the pool cold key, which no browser wallet can do, so you cast it with your pool tooling. DRepTalk then shows your vote and rationale on the action's Votes tab."
  - q: "What happens if my pool does not vote?"
    a: "Since the Plomin hard fork, a pool that does not vote is counted as a No vote. There is one lever: if the pool's reward account delegates to the predefined Abstain DRep, the missing vote counts as Abstain instead. For hard fork initiations this lever does not apply, a missing vote is always a No."
  - q: "Why is my rationale not shown next to my pool's vote?"
    a: "DRepTalk fetches rationale documents from the chain only for voters with at least 10,000 ada of voting weight. A pool with less voted stake gets its vote listed without the rationale text."
  - q: "Do SPOs vote on treasury withdrawals?"
    a: "No. Treasury withdrawals are decided by DReps and the Constitutional Committee. SPO votes count on motions of no confidence, committee changes, hard fork initiations, security-relevant parameter changes, and Info actions."
---

Stake pool operators are one of Cardano's three governance bodies, next to DReps and the Constitutional Committee. Unlike DRep votes, a pool vote cannot be cast on DRepTalk: it must be signed with your pool cold key, which no browser wallet can do. This guide covers what your vote counts on, what happens when you do not vote, and where to actually cast it.

## What your pool votes on

An SPO vote is counted on these [governance action types](/help/governance-action-types/):

- **Motions of no confidence** in the Constitutional Committee
- **Constitutional Committee changes** (adding or removing members, changing thresholds)
- **Hard fork initiations**
- **Protocol parameter changes** that touch security-relevant parameters
- **Info actions**, where votes are recorded as a signal but there is no threshold to meet

Treasury withdrawals, ordinary parameter changes, and constitution updates are decided by DReps and the Constitutional Committee without an SPO vote. Your pool's voting power is the stake delegated to it. An action passes the SPO body when the Yes stake, measured against Yes plus No, meets the threshold for that action type. The No side includes the stake of pools that did not vote (see below), while abstaining stake is left out of the calculation.

## Not voting is also a vote

Since the Plomin hard fork, a pool that does not vote on an action is counted as a **No** vote, not as absent. There are two exceptions, both controlled by where your pool's **reward account** delegates its own voting power:

- Reward account delegated to the predefined **Abstain** DRep: your missing vote counts as Abstain, so your stake is taken out of the calculation instead of dragging the Yes ratio down.
- Reward account delegated to the predefined **No confidence** DRep: your missing vote counts as Yes on motions of no confidence, and No on everything else.

**Hard fork initiations are the exception to the exceptions.** A pool that does not vote on a hard fork is always counted as No, regardless of how the reward account delegates. If you want a hard fork to happen, you have to actively vote Yes.

## Which key signs

A pool vote is witnessed by your **pool cold key**, the same key that signs pool certificates. Keep the usual discipline: build the vote on an online machine, sign on your air-gapped setup. Your Calidus key cannot cast votes. It only signs you in to sites like DRepTalk, see [Signing in](/help/signing-in/).

## Where to cast your vote

- The [SPO governance guide on the Cardano Developer Portal](https://developers.cardano.org/docs/operators/governance/spo-governance/) walks through the full flow with `cardano-cli`, including the air-gapped signing step.
- The [SPO Scripts](https://github.com/gitmachtl/scripts/blob/master/cardano/mainnet/usage_governance.md) collection wraps the same flow in two commands (`24a_genVote.sh` and `24b_regVote.sh`) and also supports hardware wallets.
- The [Cardano Foundation voting tool](https://voting.cardanofoundation.org/) helps you prepare the vote and its metadata in the browser and supports SPO voters.

## Add a rationale

Like a DRep vote, a pool vote can carry a link to a rationale document explaining your decision. The tools above let you attach one when you build the vote. It is worth the extra step: your rationale is shown next to your vote on DRepTalk and helps delegators understand how your pool participates. What makes a rationale useful is covered in [Writing a vote rationale](/help/writing-a-vote-rationale/), the format is the same for every voter role.

## Your vote on DRepTalk

Once your vote is on-chain, DRepTalk picks it up automatically: it appears on the action's Votes tab with your pool name, and your rationale is shown with it.

One limit applies to the rationale text: DRepTalk fetches rationale documents from the chain only for voters with at least 10,000 ada of voting weight. A pool with less voted stake still gets its vote listed, but without the rationale text. Since a pool vote is always cast outside DRepTalk, there is no other path for it. [Sign in as an SPO](/help/signing-in/) with your Calidus key to also join the discussion under each action, before or after voting.

## Related

- [Governance action types](/help/governance-action-types/)
- [Signing in](/help/signing-in/)
- [Writing a vote rationale](/help/writing-a-vote-rationale/)
- [Understanding a governance action page](/help/understanding-a-governance-action/)
- [Data freshness](/help/data-freshness/)
