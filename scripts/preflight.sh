#!/usr/bin/env bash
# Local mirror of the CI `check` job (.github/workflows/ci.yml), so a PR is
# verified against the same gates before it is pushed. Runs the gates in the
# same order and fails fast on the first one, exactly like CI. The only step
# CI runs that this omits is `npm ci`: locally the dependencies are already
# installed, and a clean reinstall would be slow and destructive.
#
# Run it with `npm run preflight` from the repo root before opening a PR.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

# Gate: Astro routes every supported file under src/pages except
# underscore-prefixed ones, so a test file outside a __tests__/ dir becomes a
# public production route. Cheap and dependency-free, so it runs first.
step 'Routed-pages guard'
if find src/pages \( -name '*.test.*' -o -name '*.spec.*' \) ! -path '*/_*' | grep .; then
  echo 'These test files would be routed into the production Worker; put route tests in a colocated __tests__/ folder.'
  exit 1
fi

step 'Typecheck (astro check)'
npm run typecheck

step 'Lint (biome)'
npm run lint

step 'Tests (vitest)'
npm test

step 'Build'
npm run build

# Gate: the built artifact must stay free of test-runner imports (a routed test
# file or a bundling regression would pull `cloudflare:test` into dist).
step 'Built-artifact guard'
if grep -rl 'cloudflare:test' dist/; then
  echo 'Built artifact contains test-runner imports.'
  exit 1
fi

# Gate: production dependencies must be free of high and critical vulnerabilities.
# This is the gate that silently reds every open PR when a fresh advisory lands
# against a build-tree dependency, so mirror it here to catch it before pushing.
step 'Audit production deps (gate on high)'
npm audit --omit=dev --audit-level=high

printf '\n\033[1;32mPreflight passed: all CI gates green.\033[0m\n'
