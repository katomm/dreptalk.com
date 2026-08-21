---
title: "Signing in"
description: "Who can sign in to DRepTalk and with which Cardano keys: DReps (CIP-95 DRep key), proposers (reward address), SPOs (Calidus key), CC members (committee hot key), and delegators (read-only). No password, no transaction, no fees."
cardLabel: "Signing in"
category: "Start here"
order: 4
updated: 2026-08-02
---

DRepTalk has no passwords and no accounts to create. You sign in with your Cardano
wallet by signing a one-time challenge, which proves you control an on-chain
governance identity. Signing in is **non-custodial**: it is a message
signature, not a transaction, so there is nothing to send and no fees, and the server
never sees your private keys. There are four writer roles, one for each on-chain
governance identity, plus a read-only delegator sign-in for ada holders who want to
follow their DRep. DReps, proposers, and delegators connect a CIP-30 wallet; SPOs and
CC members sign the challenge offline with cardano-signer and paste the result, because
wallets cannot sign with those keys yet.

<img class="shot" src="/help/shots/account-menu.webp" alt="The sign-in menu in the site header: enter as DRep, delegator, SPO, CC member, or proposer, or register as a DRep" width="237" height="285" loading="lazy" />

## DReps

Pick the **DRep** role and connect a CIP-95 capable wallet
(for example Lace, Eternl, or Typhon). You sign with your **DRep key**.
We derive your DRep ID from that signature and confirm on-chain that it belongs to a
registered, active DRep. If your wallet is not yet a registered DRep, you can
[register as a DRep](/register-drep/) first.

<img class="shot" src="/help/shots/signin-drep.webp" alt="The sign-in screen with the DRep role selected: connected wallet, the sign-in methods, and the multisig / script DRep toggle" width="650" height="510" loading="lazy" />

**Multisig and script DReps.** A DRep controlled by a native multisig script signs
in with the "This is a multisig / script DRep" toggle: enter the script DRep ID and
prove membership by signing with one of the script's authorized keys. Plutus-script
DReps cannot sign in, since they have no member keys to sign with.

## Proposers

Pick the **Proposer** role. You sign with your wallet's
**reward (stake) address**, and we confirm on-chain that this address
submitted at least one governance action. Use the same wallet that submitted the
action. Listed moderators also sign in through this flow, and so do
**co-proposers**: people a proposer has authorized to write on their behalf,
using their own wallet. How a proposer invites and revokes co-proposers is
covered in [Proposers](/help/proposers/).

## Stake pool operators

Pick the **SPO** role. You sign with your **Calidus key**, a
hot key you register once to your pool on-chain (CIP-151), so you never expose your
pool cold key. Wallets cannot sign with a Calidus key yet, so you sign the challenge
offline with [cardano-signer](https://github.com/gitmachtl/cardano-signer)
and paste the result. We match your Calidus public key on-chain and confirm it belongs
to a registered pool. Note that the Calidus key only signs you in: casting your
pool's vote on a governance action works differently and is covered in
[Voting as an SPO](/help/voting-as-an-spo/).

## Constitutional Committee members

Pick the **CC member** role. You sign with your committee
**hot key** using the same offline cardano-signer paste flow. We confirm
on-chain that the key is a currently authorized committee hot credential. Script-based
credentials are not supported yet.

## Delegators

Pick the **Delegator** role and connect the wallet that holds your delegated ada. Any
CIP-30 wallet works; no governance features are required. You sign with your wallet's
**reward (stake) address**, and DRepTalk reads your delegation from the chain. A
delegator sign-in is **read-only**: you can follow your DRep's votes on your start
page and get notified, but posting and voting stay reserved for the writer roles
above. See [Tracking your delegation](/help/for-delegators/) for what you get.

## On a phone or tablet

Mobile browsers have no wallet extension, so there is nothing there to sign
the challenge with. Instead, sign in on a computer first, then pair the
phone: the phone shows a short code, and you approve that code on the
computer. See [Pair a phone or tablet](/help/pair-a-device/).

A paired device is a normal signed-in device: it can read, post and comment,
and it can receive push notifications. Voting still needs a wallet
signature, so votes are cast from a computer.

## What signing in does not do

It never moves your funds, never submits a transaction, and never asks for a seed
phrase or private key. If your wallet ever prompts you to approve a transaction or a
payment to sign in, stop: that is not how DRepTalk works.

## Related

- [Managing your DRep](/help/managing-your-drep/)
- [Become a DRep](/help/become-a-drep/)
- [Delegate to a DRep](/help/delegate-to-a-drep/)
- [Tracking your delegation](/help/for-delegators/)
- [Pair a phone or tablet](/help/pair-a-device/)
