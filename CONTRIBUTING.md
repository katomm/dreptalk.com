# Contributing to DRepTalk

Thanks for your interest in improving DRepTalk, a wallet-authenticated discussion forum for Cardano governance. Contributions of all sizes are welcome: bug reports, fixes, docs, and features.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/katomm/dreptalk.com/issues/new). For bugs, include what you did, what you expected, and what happened, plus the network you were on (mainnet or preprod) and any console or server output.

For suspected security issues, please do not open a public issue. See [Security](#security) below.

## Getting set up

Setup, local development, the database, and running governance syncs are all documented in the [README](README.md). In short:

```sh
npm install
npm run db:migrate:local   # apply migrations to the local D1 database (required once)
npm run dev                # app dev server
```

Local and preview run against the Cardano preprod testnet. See the README for the full picture.

## Development workflow

1. Fork the repository and create a branch off `main`. Use a descriptive, prefixed name: `feat/`, `fix/`, `docs/`, `chore/`, or `style/` (for example `fix/vote-badge-timezone`).
2. Make your change. Keep each pull request focused on one thing; smaller, self-contained changes are easier to review and merge.
3. Make sure the checks below pass locally.
4. Open a pull request against `main` with a clear description of what changed and why.

### Checks that must pass

CI runs these on every pull request, and a PR cannot merge until they are green. Run them locally first:

```sh
npm run typecheck   # astro check
npm run lint        # Biome lint
npm test            # Vitest unit and integration tests
```

CI also runs `npm audit --omit=dev --audit-level=high` and fails on high or critical vulnerabilities in production dependencies.

### Code style

Code is linted with [Biome](https://biomejs.dev/). The linter is the CI gate, so keep your changes lint-clean:

```sh
npm run lint        # check
npm run lint:fix    # apply safe fixes
```

Match the style of the surrounding code: 2-space indentation, single quotes, semicolons, trailing commas, and a 100-character line width (see `biome.json`). Please scope formatting to the lines you touch rather than reformatting whole files, so diffs stay reviewable.

Write code comments and commit messages in English.

### Tests

Add or update tests for behavior you change. Use `npm run test:watch` while developing. Tests live next to the code they cover and run on the Cloudflare Workers test pool.

## Commit and pull request conventions

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with these prefixes:

`feat:` new feature, `fix:` bug fix, `i18n:` translations, `docs:` documentation, `chore:` tooling and maintenance, `style:` formatting only.

Keep the subject line short, specific, and in the imperative, for example `fix: keep vote badge in sync with cron cadence`. PR titles follow the same convention; the description should be a short, clear list of what changed.

## License

By contributing, you agree that your contributions are licensed under the project's [Apache 2.0 License](LICENSE).

## Security

If you find a vulnerability, please report it privately rather than opening a public issue, so it can be fixed before it is widely known. Email [dreptalk.padding436@passmail.net](mailto:dreptalk.padding436@passmail.net) or use GitHub's private security advisory feature for this repository. See [SECURITY.md](SECURITY.md) for details.
