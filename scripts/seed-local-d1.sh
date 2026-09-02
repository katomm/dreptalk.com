#!/usr/bin/env bash
# Seed this git worktree's local Cloudflare state (D1, and KV/R2 when present) from
# the primary worktree's miniflare state, so a fresh worktree renders real data
# without running a full on-chain sync. The primary worktree is auto-detected via
# git, so there are no hardcoded paths and this works on any machine.
#
# Usage: npm run db:seed:from-main   (stop the dev server first; miniflare caches the DB on start)
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
primary="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"

if [ "$primary" = "$root" ]; then
  echo "Already in the primary worktree, nothing to seed."
  exit 0
fi

src="$primary/.wrangler/state/v3"
dst="$root/.wrangler/state/v3"

if [ ! -d "$src/d1" ]; then
  echo "No local D1 state in the primary worktree:"
  echo "  $src/d1"
  echo "Run the app there once (npm run dev) so miniflare creates it, then retry."
  exit 1
fi

# D1 is the one that matters for rendering; KV and R2 come along when present so
# cached avatars and OG bits work too. cp of the sqlite files is enough, miniflare
# reads them fresh on the next server start.
for ns in d1 kv r2; do
  [ -d "$src/$ns" ] || continue
  mkdir -p "$dst/$ns"
  cp -Rf "$src/$ns/." "$dst/$ns/"
done

echo "Seeded local state from the primary worktree:"
echo "  $primary"

# A copy carries the primary's data AND its schema, which may lag this worktree's
# code. Apply any migrations added since the primary last ran, so tables like
# action_rationale exist and detail pages do not 500 with "no such table".
echo "Applying local migrations to match this worktree's schema..."
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state

echo "Done. Restart the dev server if it was running (it caches the DB on start)."
