---
title: "Managing your DRep: register, change metadata, get your deposit back"
description: "How to register as a Cardano DRep, change your on-chain metadata (name, objectives, links, image), and deregister to get your 500 ada deposit back. Step by step and non-custodial: your wallet signs every transaction."
cardLabel: "Managing your DRep"
category: "For DReps"
order: 1
updated: 2026-09-02
faqs:
  - q: "How do I register as a DRep on Cardano?"
    a: "Open Register as a DRep, connect a CIP-95 capable wallet (for example Lace, Eternl, or Typhon), and fill in your profile: name, objectives, links, and an optional image. Your wallet submits the registration certificate. Registering locks a refundable 500 ada deposit plus a small network fee. The deposit is returned in full when you later deregister."
  - q: "How do I change my DRep metadata?"
    a: "Sign in as a DRep and open Settings. The form is prefilled with your current on-chain profile (name, objectives, links, image). Edit it and submit. Your wallet signs an update certificate that points to the new metadata. The change is on the chain as soon as the transaction confirms. DRepTalk shows it right away, wallets and explorers after their next sync."
  - q: "How much does it cost to update my DRep metadata?"
    a: "Updating your metadata has no deposit. Your wallet pays only the small Cardano network fee. The 500 ada deposit is only locked once, at registration, and stays locked until you deregister."
  - q: "How do I get my 500 ada DRep deposit back?"
    a: "The 500 ada deposit is refunded automatically when you deregister (retire) your DRep. Sign in as a DRep, open Settings, and use Retire DRep. Your wallet submits a deregistration certificate, and the full deposit is returned to your wallet once the transaction confirms."
  - q: "Does retiring my DRep delete my DRepTalk forum account?"
    a: "No. Deregistering is an on-chain action only. It retires your DRep on Cardano and refunds your deposit, but it does not delete your DRepTalk forum account, your posts, or your profile page."
---

DRepTalk can submit the three on-chain DRep lifecycle actions for you:
registering, changing your metadata, and deregistering (which returns your
deposit). All of them are **non-custodial**: dreptalk.com never sees your keys;
your wallet signs and submits each transaction, so you always confirm the exact
certificate and cost in your wallet. You need a CIP-95 capable wallet (for
example Lace, Eternl, or Typhon).

## How do I register as a DRep on Cardano?

Go to [Register as a DRep](/register-drep/), connect your wallet, and fill in
your profile: name, your objectives, links, and an optional profile image (JPG
or PNG, up to 256 KB). Behind **Show advanced fields** you can also add
motivations, qualifications, a payment address, and the CIP-119 "do not list"
flag (kept in your metadata, DRepTalk still shows you). DRepTalk hosts this as a CIP-119 metadata document and your
wallet submits the registration certificate pointing at it. Registration locks a
**refundable 500 ada deposit** plus a small network fee; the deposit comes back
in full when you later deregister.

## How do I set up or change my DRep metadata?

Your on-chain metadata is what wallets, explorers, and DRepTalk show to
delegators. If yours is outdated, or you registered without any, sign in as a
DRep and open [Settings](/settings/). The form is prefilled with your current
on-chain profile. Edit the name, objectives, or links, upload an image if you
like, and submit. Your wallet signs an update certificate that points to the new document.
There is **no deposit** for updates, only the small network fee.

The change is on the chain as soon as the transaction confirms. When you submit
it through DRepTalk, your profile here updates right away. Wallets and explorers
show it after their next sync. A profile you change with another tool reaches
DRepTalk with the next metadata re-read, which runs every six hours.

## How do I get my 500 ada DRep deposit back?

The 500 ada you locked when you registered is refunded automatically when you
**deregister** (retire) your DRep. Sign in as a DRep, open [Settings](/settings/),
and use **Retire DRep** in the danger zone. Your wallet submits a deregistration
certificate, and the full deposit is returned to your wallet once the transaction
confirms. There is no separate withdrawal step and no extra deposit; you pay only
the small network fee for the transaction.

## How do I retire (deregister) my DRep?

Retiring is done from [Settings](/settings/). It submits a deregistration
certificate to the chain: your 500 ada deposit is refunded once it confirms, and
everyone who delegated their voting power to you loses that delegation. You can
register again later, but delegators would need to delegate to you again.

Retiring is an **on-chain action only**. It does not delete your DRepTalk forum
account, your posts, or your profile page.

## What these actions never do

None of them move your funds beyond the shown deposit and fee, and none ask for a
seed phrase or private key. Your wallet shows you the certificate and the exact
cost before anything is submitted; if something looks different, reject it.

## Related

- [How to become a DRep](/help/become-a-drep/)
- [Writing a vote rationale](/help/writing-a-vote-rationale/)
