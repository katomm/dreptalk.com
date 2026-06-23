---
title: "Signing in"
description: "Who can sign in to DRepTalk and with which keys: DReps (CIP-95 DRep key), proposers (reward address), SPOs (Calidus key) and CC members (committee hot key). No password, no transaction, no fees."
cardLabel: "Signing in"
category: "Start here"
order: 3
---

DRepTalk has no passwords and no accounts to create. You sign in with your Cardano
wallet by signing a one-time challenge, which proves you control an on-chain
governance identity. Signing in is **non-custodial**: it is a message
signature, not a transaction, so there is nothing to send and no fees, and the server
never sees your private keys. There are four ways to sign in, one for each on-chain
writer role. DReps and proposers connect a CIP-30 wallet; SPOs and CC members sign the
challenge offline with cardano-signer and paste the result, because wallets cannot sign
with those keys yet.

## DReps

Pick the **DRep** role and connect a CIP-95 capable wallet
(for example Lace, Eternl, or Typhon). You sign with your **DRep key**.
We derive your DRep ID from that signature and confirm on-chain that it belongs to a
registered, active DRep. Script-based DReps are not supported yet. If your wallet is
not yet a registered DRep, you can [register as a DRep](/register-drep) first.

## Proposers

Pick the **Proposer** role. You sign with your wallet's
**reward (stake) address**, and we confirm on-chain that this address
submitted at least one governance action. Use the same wallet that submitted the
action. Listed moderators can also sign in through this flow.

## Stake pool operators

Pick the **SPO** role. You sign with your **Calidus key**, a
hot key you register once to your pool on-chain (CIP-151), so you never expose your
pool cold key. Wallets cannot sign with a Calidus key yet, so you sign the challenge
offline with [cardano-signer](https://github.com/gitmachtl/cardano-signer)
and paste the result. We match your Calidus public key on-chain and confirm it belongs
to a registered pool.

## Constitutional Committee members

Pick the **CC member** role. You sign with your committee
**hot key** using the same offline cardano-signer paste flow. We confirm
on-chain that the key is a currently authorized committee hot credential. Script-based
credentials are not supported yet.

## What signing in does not do

It never moves your funds, never submits a transaction, and never asks for a seed
phrase or private key. If your wallet ever prompts you to approve a transaction or a
payment to sign in, stop: that is not how DRepTalk works.

## Related

- [Managing your DRep](/help/managing-your-drep)
- [Become a DRep](/help/become-a-drep)
- [Delegate to a DRep](/help/delegate-to-a-drep)
