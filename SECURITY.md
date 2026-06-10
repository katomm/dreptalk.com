# Security Policy

DRepTalk is a wallet-authenticated forum for Cardano governance. Reading is public; writing is gated to on-chain roles proven by a wallet signature, and the app never takes custody of keys. We take security reports seriously and appreciate responsible disclosure.

## Supported versions

DRepTalk is a continuously deployed web application; there are no released versions to track. The live site at [dreptalk.com](https://dreptalk.com) always runs the latest code from `main`. Please report issues against the current `main` branch and the live site.

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

Out of scope:

- Vulnerabilities in third-party services we depend on (for example Cloudflare, Koios, or wallet software). Report those to the respective vendor.
- Issues that require a compromised wallet, device, or browser extension.
- Denial of service through sheer request volume, and findings from automated scanners without a demonstrated, realistic impact.

## What to expect

- We will acknowledge your report as soon as we reasonably can.
- We will keep you informed as we investigate and work on a fix.
- We will credit you for the find if you would like, once the issue is resolved.

Thank you for helping keep DRepTalk and its users safe.
