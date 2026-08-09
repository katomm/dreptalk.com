#!/usr/bin/env bash
# Interactive confirmation guard for actions that hit the MAINNET (production)
# Cloudflare resources: the app/gov-sync deploys and the D1 migration apply.
# Prints the target and requires the operator to type "mainnet" verbatim.
#
# Why: the top-level wrangler.toml is the mainnet config (the astro-cloudflare
# adapter reads only the top level), so a bare `wrangler deploy` or
# `wrangler d1 migrations apply DB --remote` silently touches production. These
# npm scripts route through this guard so no mainnet action runs without a
# deliberate confirmation.
#
# Flags (via env):
#   CONFIRM_PROD_OK=1    Skip the prompt entirely. A parent script (e.g.
#                        deploy:mainnet) confirms once and sets it so the leaf
#                        scripts it calls do not re-prompt.
#   CONFIRM_PROD_SOFT=1  "Soft" mode for the deploy scripts: only prompt for a
#                        human at a terminal, and proceed without a prompt in any
#                        automated context (no tty, or CI set). Cloudflare
#                        Workers Builds runs `npm run deploy` on merge, so the
#                        deploy guard must never block that pipeline; it only
#                        guards a human running a mainnet deploy by hand. The
#                        migration scripts leave this unset so a non-interactive
#                        run is refused outright (CI never migrates).
set -euo pipefail

target="${1:-mainnet production}"

if [ "${CONFIRM_PROD_OK:-}" = "1" ]; then
  exit 0
fi

if [ ! -t 0 ] || [ -n "${CI:-}" ]; then
  if [ "${CONFIRM_PROD_SOFT:-}" = "1" ]; then
    # Automated deploy (e.g. Workers Builds): proceed without a prompt.
    exit 0
  fi
  # Strict guard (migrations): a non-interactive run must never slip through.
  echo "Refusing to touch $target: no interactive terminal to confirm." >&2
  echo "This is a deliberate production action, run it from an interactive shell." >&2
  exit 1
fi

printf '\n  About to run against MAINNET (production): %s\n' "$target" >&2
printf '  Type "mainnet" to proceed, anything else aborts: ' >&2
read -r reply
if [ "$reply" != "mainnet" ]; then
  echo "Aborted." >&2
  exit 1
fi
