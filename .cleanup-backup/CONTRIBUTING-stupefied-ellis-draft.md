# Contributing to DRepTalk

Thanks for your interest in improving DRepTalk. This document covers how to get
the project running locally and what we expect from a pull request. For the full
picture of the stack and architecture, read the [README](README.md) first.

## Code of conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating you
are expected to uphold it.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/katomm/dreptalk.com/issues/new). For
bugs, include steps to reproduce, what you expected, and what happened instead.
For security vulnerabilities do **not** open a public issue; see
[SECURITY.md](SECURITY.md).

## Development setup

Requires Node 20+. Local and preview run against the Cardano preprod testnet.

```sh
npm install
npm run db:migrate:local   # apply all migrations to the local D1 database (required once)
npm run dev                # app dev server (Astro, with HMR)
```

A fresh clone has an empty database until you run the migration step, and pages
that read on-chain data stay empty until you trigger a sync by hand. The README
explains both in detail:

- [Database setup](README.md#database-setup)
- [Running a governance sync locally](README.md#running-a-governance-sync-locally)

## Before you open a pull request

Run the same checks CI runs and make sure they pass:

```sh
npm run lint        # Biome lint (CI gate); npm run lint:fix applies safe fixes
npm run typecheck   # astro check
npm test            # unit and integration tests (Vitest)
```

CI gates on `npm run lint`, not on formatting, so a repo-wide reformat is not
expected or wanted. Keep changes scoped to what you touched.

## Pull request guidelines

- **Branch** off `main` with a descriptive name (`feat/...`, `fix/...`,
  `docs/...`, `chore/...`). Do not push to `main` directly.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `i18n:`, `chore:`, `docs:`, `style:`. One short, specific
  subject line, no trailing period.
- **Scope:** keep a PR focused on one change. Describe what changed as a short
  list of bullets.
- **Tests:** add or update tests for behavior you change. Bug fixes should come
  with a test that fails before the fix.
- **Language:** code, comments, and commit messages are written in English.
  User-facing copy follows whatever language that surface requires.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers this project.
