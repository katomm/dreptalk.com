# Security Policy

DRepTalk is a wallet-authenticated forum for Cardano governance. Reading is public; writing is gated to on-chain roles proven by a wallet signature, and the app never takes custody of keys. We take security reports seriously and appreciate responsible disclosure.

## Security model

A couple of assumptions underpin everything below. They are deliberate design decisions, not oversights.

- **Non-custodial, with no server-side submission.** The app never receives, stores, or derives a private key. Every transaction is signed and submitted by the user's own wallet, which shows it first; the server only assembles unsigned transactions and verifies witnesses against the script's authorized signers. There is no server-side path that can move or drain funds, and transaction submission is never proxied through the app.
- **Script (multisig) DReps share one forum identity.** A member authenticates by proving control of a key that is an authorized signer of the DRep's native script, and then acts in the forum as that DRep. Any single authorized member can post, edit the DRep profile, and record votes on the collective's behalf. On-chain governance is unaffected: casting an actual vote still requires the script's full signing threshold, collected through the multisig flow. So treat a compromised member key as able to speak for the DRep in the forum, but not to pass a governance action on its own.

## Supported versions

DRepTalk is a continuously deployed web application. The live site at [dreptalk.com](https://dreptalk.com) always runs the latest code from `main`, and the GitHub releases (listed at [/help/whats-new](https://dreptalk.com/help/whats-new/)) are changelog markers, not maintained versions: only `main` receives fixes. Please report issues against the current `main` branch and the live site.

## Reporting a vulnerability

Please report security issues privately, not in a public GitHub issue, so they can be fixed before they are widely known.

- Email: [dreptalk.padding436@passmail.net](mailto:dreptalk.padding436@passmail.net).
- Alternative: open a private advisory through GitHub's [Report a vulnerability](https://github.com/katomm/dreptalk.com/security/advisories/new) feature for this repository.

When reporting, please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected URL or code path, and the network (mainnet or preprod).
- Any relevant logs, requests, or screenshots.

Please give us a reasonable chance to fix the issue before disclosing it publicly.

## Scope

In scope:

- The web application and its API routes.
- The wallet-signature authentication and on-chain role gating.
- The moderation and rate-limiting logic.
- The governance sync worker and how it writes to the database.
- The notification channels: browser push, the Telegram bot webhook, and the in-app inbox.
- Device pairing and the signed-in device list.

Out of scope:

- Vulnerabilities in third-party services we depend on (for example Cloudflare, Koios, or wallet software). Report those to the respective vendor.
- Issues that require a compromised wallet, device, or browser extension.
- Denial of service through sheer request volume, and findings from automated scanners without a demonstrated, realistic impact.

## What to expect

- We will acknowledge your report as soon as we reasonably can.
- We will keep you informed as we investigate and work on a fix.
- We will credit you for the find if you would like, once the issue is resolved.

Thank you for helping keep DRepTalk and its users safe.
