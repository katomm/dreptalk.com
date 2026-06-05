# DRepTalk

Wallet-authenticated discussion forum for Cardano governance, running at [dreptalk.com](https://dreptalk.com).

Incoming on-chain Governance Actions automatically open a thread, and verified DReps, SPOs, CC members, and proposers discuss them next to the live on-chain vote data. Reading is public; writing is gated to verified on-chain roles (no custody of keys, signature-based login).

The aim is a calmer, accountable home for governance discussion, away from the drama of social media.

## Stack

Astro (SSR) on Cloudflare Pages, with D1 and KV. A standalone cron worker ingests governance actions. Chain data via Koios. Defaults to mainnet; set `CARDANO_NETWORK=preprod` for local and preview.

## Status

Early development.

## Feedback

Bugs and feature requests: open a [GitHub issue](https://github.com/katomm/dreptalk.com/issues/new).

## License

Apache 2.0.
