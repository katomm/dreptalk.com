---
title: "For delegators: track what your DRep does"
description: "How an ada holder signs in to DRepTalk as a delegator to follow their DRep's votes, see open actions their DRep has not voted on yet, and get notified when their DRep votes or their delegation changes."
cardLabel: "Tracking your delegation"
category: "Start here"
order: 3
updated: 2026-08-02
faqs:
  - q: "Does signing in as a delegator cost anything?"
    a: "No. Signing in is a message signature, not a transaction. There is no fee, nothing is sent on-chain, and DRepTalk never sees your keys."
  - q: "Can I change my delegation on DRepTalk?"
    a: "Yes. Every DRep profile has a Delegate button. Your wallet signs and submits the delegation certificate; DRepTalk never holds your funds or keys. You can also delegate from the governance section of your wallet."
  - q: "Can delegators post or vote on DRepTalk?"
    a: "No. Posting and voting require an on-chain governance role such as DRep, proposer, SPO, or Constitutional Committee member. A delegator sign-in is read-only: it is for following your DRep and getting notified."
  - q: "Which wallets work for the delegator sign-in?"
    a: "Any Cardano wallet that can sign a message works, for example Lace, Eternl, or Typhon. You do not need a governance-capable wallet just to track your delegation."
---

If you have delegated your voting power to a DRep, the natural next question
is: what are they doing with it? DRepTalk can answer that continuously. Sign
in as a delegator and your [start page](/home/) becomes a dashboard for your
delegation, and DRepTalk notifies you when your DRep acts. Everything is
read-only and free: no transaction, no fees, no keys shared.

If you have not delegated yet, start with [How to delegate to a
DRep](/help/delegate-to-a-drep/).

## Signing in as a delegator

1. Open [Sign in](/login/) and choose the **Delegator** role.
2. Connect the wallet that holds your delegated ada. Any wallet that can
   sign a message works (for example Lace, Eternl, or Typhon).
3. Approve the signature request in your wallet.

<img class="shot" src="/help/shots/signin-delegator.webp" alt="The sign-in screen with the Delegator role selected: connect a wallet and sign a one-time message; delegators cannot post or vote" width="650" height="410" loading="lazy" />

That signature only proves you control the wallet's stake key; it is not a
transaction and costs nothing. DRepTalk reads your delegation from the chain
and links your sign-in to it. A delegator account is read-only: you can
browse everything, but posting and voting stay reserved for on-chain
governance roles.

## Your delegation dashboard

After signing in, [your start page](/home/) shows your delegation at a
glance:

- **Your DRep.** Name, picture, current voting power, and how many
  delegators they have, linked to their full profile.
- **Their recent votes.** The latest confirmed on-chain votes your DRep has
  cast, with their rationales where published.
- **What they have not voted on yet.** Open governance actions still waiting
  for your DRep's vote, with the time remaining in each voting window. This
  is the quickest way to see whether your representative is on top of the
  current ballot.

<img class="shot" src="/help/shots/delegator-dashboard.webp" alt="The delegation dashboard: the tracked DRep with voting power and delegator count, followed by their recent Yes and No votes with rationale links" width="1040" height="501" loading="lazy" />

If your voting power is delegated to one of the two special options instead
of a DRep, the dashboard explains what that means: **Always Abstain** and
**No Confidence** are standing positions, so there are no individual votes
to follow. And if you re-delegate in your wallet, the dashboard follows: the
on-chain state is re-checked when you sign in and regularly in between.

## Getting notified

Instead of checking the dashboard, you can let DRepTalk tell you. As a
delegator you receive a notification when:

- your DRep **votes or changes a vote** on a governance action,
- your DRep's **registration status changes**, for example if they retire,
- your **delegation itself changes** on-chain.

<img class="shot" src="/help/shots/delegator-notifications.webp" alt="The notifications inbox of a delegator: entries for each vote their DRep cast and for governance actions changing status" width="1040" height="740" loading="lazy" />

Notifications arrive in your on-site inbox, and optionally as browser push
notifications or Telegram messages. You choose the channels and event types
in your [notification settings](/notifications/). On a phone, [pair the
device](/help/pair-a-device/) first; on iPhone and iPad, also [add DRepTalk
to your home screen](/help/add-to-home-screen/) to enable push.

## Using what you learn

The point of tracking is a better-informed delegation. If your DRep votes
consistently and explains their reasoning, you have confirmation that your
voting power is in good hands. If they go quiet or you disagree with their
positions, you can delegate elsewhere at any time: browse the [DRep
directory](/dreps/), open a profile, and use the **Delegate** button. Your
wallet signs the change, and your dashboard follows it.

## Frequently asked questions

### Does signing in as a delegator cost anything?

No. It is a message signature, not a transaction. There is no fee and
nothing is recorded on-chain.

### Can I change my delegation on DRepTalk?

Yes. Every DRep profile has a Delegate button; your wallet signs and submits
the delegation certificate. You can also delegate from your wallet's
governance section, as described in [How to delegate to a
DRep](/help/delegate-to-a-drep/).

### Can delegators post or vote?

No. Posting and voting require an on-chain governance role. A delegator
sign-in is for following and notifications. If you want a more active role,
see [How to become a DRep](/help/become-a-drep/).

### Which wallets work?

Any Cardano wallet that can sign a message, for example Lace, Eternl, or
Typhon. Governance features like CIP-95 are not required for tracking.

## Related

- [How to delegate to a DRep](/help/delegate-to-a-drep/)
- [Signing in](/help/signing-in/)
- [Pair a phone or tablet](/help/pair-a-device/)
- [Understanding a governance action page](/help/understanding-a-governance-action/)
