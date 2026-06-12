# Local development

Requires Node 20+. Local and preview run against the Cardano preprod testnet; set `CARDANO_NETWORK=preprod` in `.dev.vars`.

- `npm install`
- `npm run db:migrate:local`: set up the local database (apply all migrations). Required before the first `npm run dev`; see [Database setup](#database-setup)
- `npm run db:seed:local`: optional fake forum data for local UI work; see [Seeding fake data](#seeding-fake-data)
- `npm run dev`: app dev server (Astro, with HMR)
- `npm test`: unit and integration tests
- `npm run typecheck`: type check
- `npm run lint`: lint with Biome (CI gate); `npm run lint:fix` applies safe fixes
- `npm run format`: format with Biome (`npm run format:check` to verify only)
- `npm run preview`: production build served via `wrangler dev`

## Database setup

The forum and governance pages read from a Cloudflare D1 (SQLite) database. In local dev both the app (through `@astrojs/cloudflare`) and the `gov-sync` cron worker use an on-disk D1 under `.wrangler/state`. That file is created automatically the first time a worker runs, but it has no tables until you apply the migrations, so a fresh clone fails with `no such table` on any page that touches the database. That missing schema is the "no database" problem a new fork hits.

Apply every migration in `migrations/` to the local database once, from the repo root:

```sh
npm run db:migrate:local        # wraps: wrangler d1 migrations apply DB --local --persist-to .wrangler/state
```

`DB` is the binding name (not the database name), and `--local` targets the SQLite file under `.wrangler/state`; the remote database is never touched. The app and the cron worker share the same `database_id` and the same `.wrangler/state`, so this single command migrates the database for both: there is nothing to migrate per worker. Re-run it whenever new files land in `migrations/`.

After migrating, the database exists but is empty: no governance actions, DReps, or tallies yet. None of that data ships in the repo. There are two ways to fill it: the seed script (fake data, instant, no network) or the governance syncs (real on-chain data), described in the next two sections. Local dev never fires the cron triggers on its own (the "crons don't run" you may have seen is expected, not a bug).

## Seeding fake data

For working on the forum UI you usually do not need real chain data. The seed script inserts a coherent fake data set: a handful of DReps, SPOs, and a CC member, discussion threads with conversations and replies, two governance actions with tallies and per-DRep votes, reactions, and one community-hidden post:

```sh
npm run db:seed:local           # wraps: wrangler d1 execute DB --local --file scripts/seed-dev.sql
```

It is re-runnable: every seeded row carries a recognizable id and is deleted and re-inserted on each run, so it also resets whatever you clicked together while testing. Timestamps are relative to "now" and the epoch numbers are calibrated for preprod, so the UI always looks current. Seed data and real synced data can coexist; re-seeding never touches synced rows. Local only: the script is never meant to run against a remote database.

## Running a governance sync locally

On-chain data is ingested by a standalone Cloudflare cron worker at `workers/gov-sync` that shares the app's D1 database. It has three cron triggers, and the worker dispatches on the cron expression, so to run a specific sync locally you pass that expression to `/__scheduled`. Start the worker once, then trigger the run you need:

```sh
npm run sync:dev                                       # terminal 1: start the worker (wrangler dev, scheduled enabled)

# terminal 2: trigger a single run. Keep the * inside quotes so the shell does not expand them.
curl "http://localhost:8787/__scheduled"                       # governance actions + tallies (default */15 cron)
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"        # per-post DRep vote lists (hourly cron)
curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"      # DRep profiles + voting power (6-hourly cron)
```

It polls Koios (preprod locally, per `CARDANO_NETWORK`) and writes to D1. Stake Participation on the governance overview needs the DRep run (it fills `dreps.voting_power`); the voted share also needs the vote run. The cron expressions mirror `src/lib/freshness.ts`.

The first DRep run is the heavy one without a `KOIOS_API_KEY`: it enumerates every DRep from an empty database, which is rate-limit heavy on anonymous Koios. Set `KOIOS_API_KEY` in `.dev.vars` before the first run; a free [koios.rest](https://koios.rest) account is enough for local work (a Pro key is recommended for production), and the same token works on every network (see [Deployment](deployment.md)). Subsequent runs are incremental and much lighter.

The sync is built to survive a bad run. Koios calls retry transient failures (5xx, 429, network errors) with exponential backoff and honor `Retry-After`; all writes are idempotent upserts, so a re-run resumes where the last one left off; and the DRep run caps its CIP-119 anchor fetches per run, marking the rest `deferred` so a large backlog drains over the next few runs instead of exceeding the Workers subrequest limit. Every run is recorded in the `sync_runs` table with an `ok` / `partial` / `error` status and per-phase outcomes (one failing pass no longer skips the rest); `/debug/sync` shows the recent runs, durations, item counts, errors, and the next scheduled run.

---

See also: [Deployment](deployment.md) · [Contributing](../CONTRIBUTING.md) · [README](../README.md)
