<p align="center">
  <img src="https://dreptalk.com/logo-mark.svg" alt="DRepTalk logo" width="88" />
</p>

<h1 align="center">DRepTalk</h1>

<p align="center">
  <a href="https://github.com/katomm/dreptalk.com/actions/workflows/ci.yml"><img src="https://github.com/katomm/dreptalk.com/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://dreptalk.com"><img src="https://img.shields.io/website?url=https%3A%2F%2Fdreptalk.com&amp;up_message=online&amp;down_message=offline&amp;label=mainnet" alt="Mainnet status" /></a>
  <a href="https://preprod.dreptalk.com"><img src="https://img.shields.io/website?url=https%3A%2F%2Fpreprod.dreptalk.com&amp;up_message=online&amp;down_message=offline&amp;label=preprod" alt="Preprod status" /></a>
</p>

Wallet-authenticated discussion forum for Cardano governance, running at [dreptalk.com](https://dreptalk.com).

Incoming on-chain Governance Actions automatically open a thread, and DReps, SPOs, CC members, and proposers discuss them next to the live on-chain vote data. Reading is public; writing is gated to those on-chain roles, each proven by a wallet signature (no custody of keys, signature-based login).

The aim is a calmer, accountable home for governance discussion, away from the drama of social media.

## Quickstart

Requires Node 20+. Local and preview run against the Cardano preprod testnet; set `CARDANO_NETWORK=preprod` in `.dev.vars`.

```sh
npm install
npm run db:migrate:local   # set up the local database, required once before the first dev run
npm run db:seed:local      # optional: fake forum data (users, threads, governance actions) to click around
npm run dev                # app dev server (Astro, with HMR)
```

For the full local setup, the database, and running governance syncs by hand, see [docs/development.md](docs/development.md). For shipping to mainnet and preprod, see [docs/deployment.md](docs/deployment.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, code style, and commit and pull request conventions.

## Security

Found a vulnerability? Please report it privately, not in a public issue. See [SECURITY.md](SECURITY.md).

## Stack

Astro (SSR) on Cloudflare Workers, with D1, KV, and a Durable Object for atomic rate limiting. A standalone cron worker ingests governance actions. Chain data via Koios, used anonymously by default; set `KOIOS_API_KEY` for higher rate limits (registering at [koios.rest](https://koios.rest) is free, and the free-tier token is plenty). Defaults to mainnet; set `CARDANO_NETWORK=preprod` for local and preview.

Moderation is community-first: any on-chain writer (DRep, SPO, CC member, or proposer) can flag a post, and a post is hidden behind a placeholder once three distinct writers have flagged it. Every writer is a wallet-verified governance participant, and registering as a DRep locks a refundable 500 ADA deposit, so coordinated abuse is expensive and this lightweight check is expected to be enough in early operation; the post author and moderators can still read a hidden post. Moderators and admins can be granted by stake address through the `MODERATORS` env value (comma-separated `stakeAddress` or `stakeAddress:role`, role `admin` or `moderator`), empty by default: they sign in with the normal stake-key wallet flow, and the allowlist only adds the moderation role.

On-chain values (governance tallies and status, DRep profiles, per-post vote badges) are synced on crons and are cached, not live; every place they appear shows an "as of" time. The exact cadences live in one place, `src/lib/freshness.ts`, and are published at `/help/data-freshness`.

DRepTalk ships an imprint and privacy page (`/imprint`, `/privacy`), the operator disclosure that German and EU law require for a public site. The policy text is public and lives in the repo; the operator's own details are injected from `LEGAL_*` env vars so they stay out of the repository. The exact variables are documented in [`src/lib/legal.ts`](src/lib/legal.ts); set them in `.dev.vars` locally and as Worker vars in production. If you run DRepTalk outside Germany or the EU, adapt these pages to your own jurisdiction.

## Status

Live on mainnet and actively developed in the open.

## Feedback

Bugs and feature requests: open a [GitHub issue](https://github.com/katomm/dreptalk.com/issues/new).

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
