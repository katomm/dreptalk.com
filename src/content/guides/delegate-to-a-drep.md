---
title: "How to delegate your voting power to a DRep"
description: "How any ADA holder hands their Cardano voting power to a DRep, what Abstain and No Confidence mean, and how to switch DReps later."
cardLabel: "Delegating to a DRep"
category: "Start here"
order: 2
updated: 2026-06-23
---

Every ADA holder on Cardano has voting power in the governance system. If you
do not want to vote yourself, you can hand that power to a DRep (delegated
representative) who will vote on your behalf. This guide explains how
delegation works, how to choose a DRep, and what your options are if you
prefer not to delegate to a specific person.

## What delegating voting power means

When you delegate your voting power, your ADA stays in your wallet the entire
time. You are not sending your ADA anywhere and you do not lock it up. The
only thing you are delegating is the right to cast governance votes with your
stake weight.

Delegating voting power is also completely separate from staking your ADA to a
stake pool for rewards. You can do both at the same time: keep your ADA staked
to a stake pool and simultaneously delegate your governance vote to a DRep.
Changing one does not affect the other.

Your delegation is proportional to your stake. If you hold a larger balance,
your delegation carries more weight in the governance system.

## Choosing a DRep

Browse the [DRep directory](/dreps) to find someone whose views align with
yours. Each DRep profile shows their name, a bio describing their governance
philosophy, and their activity: which actions they voted on and what
rationales they published.

A few things worth checking before you delegate:

- **Activity.** Has this DRep voted recently? Missed votes reduce their
  effectiveness as your representative.
- **Rationales.** Do they explain their votes? Published rationales let you
  judge whether their reasoning matches your own values.
- **Profile completeness.** A well-maintained profile is a good signal that
  the DRep is engaged.

There is no lock-in. You can switch to a different DRep or change your
delegation at any time.

## How to delegate

Delegation is done inside your wallet. You need a CIP-95 capable wallet:
Lace, Eternl, and Typhon all support this.

1. Open the governance or voting section of your wallet.
2. Find the DRep you want to delegate to. You can search by DRep ID, which
   you can copy from their profile on the [DRep directory](/dreps).
3. Select the DRep and confirm the delegation transaction.
4. Your wallet shows you the exact cost before anything is sent. There is no
   deposit; you pay only a small network fee, similar to a standard Cardano
   transaction.

Once the transaction confirms on-chain, your voting power is delegated.

## Abstain and No Confidence

Besides delegating to a specific DRep, two special options exist:

**Always Abstain** registers your stake as participating in governance but
counts your weight on neither the Yes nor the No side of any action. Use this
if you want to signal that you are an active participant but you prefer not to
take a position on current proposals. Your stake contributes to quorum without
influencing the outcome.

**No Confidence** votes against the current governance setup on every active
action. Use this if you believe the existing governance structure lacks
legitimacy and you want your stake to reflect that view consistently, without
having to delegate to a specific DRep.

Both options are selected from the same delegation flow in your wallet, in
place of a specific DRep.

## Switching or changing later

You can re-delegate at any time. Submit a new delegation transaction to a
different DRep (or to Abstain, or No Confidence), and the latest delegation
wins. There is nothing to withdraw or cancel first; the new transaction simply
replaces the old one.

The only cost is the small network fee for each delegation transaction.

## Related

- [How to become a DRep](/help/become-a-drep)
- [Governance action types](/help/governance-action-types)
