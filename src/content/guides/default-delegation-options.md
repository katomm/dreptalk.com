---
title: "What the default delegation options do"
description: "Always abstain and always no confidence explained: what each option means for governance votes, and how much stake sits in them."
cardLabel: "Default options"
category: "Understanding governance"
order: 91
faqs:
  - q: "Is always abstain the same as not delegating at all?"
    a: "No. Undelegated stake simply does not participate. Always abstain is an active choice that removes your stake from the yes and no calculation while still being counted as delegated, and for most wallets it also keeps staking rewards flowing after the transition period."
  - q: "Does always no confidence mean my stake votes no on everything?"
    a: "On almost everything. The one exception is a motion of no confidence itself, where this option counts as a yes, because supporting no confidence is exactly what it declares."
  - q: "Can I switch away from a default option later?"
    a: "Yes, at any time. Delegating to a DRep, or switching between the two default options, is a single on-chain action. See delegating your voting power for the steps."
---

When you delegate voting power on Cardano, you do not have to pick a person. The protocol ships two predefined options, and a large amount of stake sits in them. The [analytics page](/analytics/) shows how much, and how it moves per epoch.

## Always abstain

Delegating to always abstain means your stake stands aside. It is removed from the calculation that decides whether a governance action passes: it neither helps an action reach its approval threshold nor blocks it. Your stake still shows up as delegated, it just carries no yes and no weight.

That makes always abstain the honest choice if you do not want to influence outcomes. It is also why DRepTalk never counts this stake in DRep statistics: it represents a decision to sit out, not a representative.

## Always no confidence

Delegating to always no confidence means your stake continuously votes against the current governance arrangement. On regular governance actions it counts as a no. On a motion of no confidence it counts as a yes, since that motion is precisely the position this option expresses.

It is a standing protest vote: choose it if you believe the current constitutional committee should not hold its role.

## Why they matter for the numbers

Both options hold real voting weight, so they change what it takes for governance actions to pass. A treasury withdrawal, for example, needs a share of the participating stake, and stake parked in always abstain shrinks that pool while stake in always no confidence pushes against every action. The [analytics page](/analytics/) keeps both visible next to the DRep statistics, as their own layer, so you can see how much of Cardano's governance weight sits in defaults rather than with representatives.

If you would rather have a person represent you, [find a DRep that matches your views](/match/) or read [delegating your voting power](/help/delegate-to-a-drep/).
