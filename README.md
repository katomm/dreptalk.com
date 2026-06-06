# DRepTalk

Wallet-authenticated discussion forum for Cardano governance, running at [dreptalk.com](https://dreptalk.com).

Incoming on-chain Governance Actions automatically open a thread, and DReps, SPOs, CC members, and proposers discuss them next to the live on-chain vote data. Reading is public; writing is gated to those on-chain roles, each proven by a wallet signature (no custody of keys, signature-based login).

The aim is a calmer, accountable home for governance discussion, away from the drama of social media.

## Stack

Astro (SSR) on Cloudflare Workers, with D1 and KV. A standalone cron worker ingests governance actions. Chain data via Koios, used anonymously by default; set `KOIOS_API_KEY` to send an authenticated key for higher rate limits. Defaults to mainnet; set `CARDANO_NETWORK=preprod` for local and preview.

Moderators and admins are granted by stake address through the `MODERATORS` env value (comma-separated `stakeAddress` or `stakeAddress:role`, role `admin` or `moderator`); empty by default. They sign in with the normal stake-key wallet flow; the allowlist only adds the moderation role.

## Local development

Requires Node 20+. Local and preview run against the Cardano preprod testnet; set `CARDANO_NETWORK=preprod` in `.dev.vars`.

- `npm install`
- `npm run dev`: app dev server (Astro, with HMR)
- `npm test`: unit and integration tests
- `npm run typecheck`: type check
- `npm run preview`: production build served via `wrangler dev`

### Running a governance sync locally

Governance Actions are ingested by a standalone Cloudflare cron worker at `workers/gov-sync` that shares the app's D1 database. To trigger one sync run locally:

```sh
npm run sync:dev                          # start the worker (wrangler dev, scheduled enabled)
curl "http://localhost:8787/__scheduled"  # trigger a single sync run
```

It polls Koios for new governance actions (preprod locally, per `CARDANO_NETWORK`) and writes them to D1. The worker ships with the governance ingestion milestone.

## Status

Early development.

## Feedback

Bugs and feature requests: open a [GitHub issue](https://github.com/katomm/dreptalk.com/issues/new).

## License

Apache 2.0.
