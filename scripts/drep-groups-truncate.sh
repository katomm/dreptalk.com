#!/usr/bin/env bash
# Requests a truncation of the DRep groups store above a block height. The
# gov-sync worker opens it on its next governance tick under the groups lease,
# clears the request in the same write, and works it off over the following
# ticks. Then the ingest reads the chain above the height again.
#
# A reprocess lever after a bug or a stuck state: the store re-reads the same
# canonical data from Koios and rebuilds what it derived from it. It does not
# reduce storage, the store grows back to the same size.
#
# Usage: bash scripts/drep-groups-truncate.sh <preprod|mainnet> <height>
# Mainnet asks for a typed confirmation first (scripts/confirm-prod.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

network="${1:-}"
height="${2:-}"

if [[ ! "$height" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <preprod|mainnet> <height>   (height: a non-negative block height)" >&2
  exit 1
fi

sql="UPDATE drep_group_meta SET operator_truncate = $height WHERE id = 1"

case "$network" in
  preprod)
    npx wrangler d1 execute DB -c workers/gov-sync/wrangler.toml --env preprod --remote --command "$sql"
    ;;
  mainnet)
    bash scripts/confirm-prod.sh "DRep groups truncation above height $height (mainnet DB \"dreptalk\")"
    npx wrangler d1 execute DB --remote --command "$sql"
    ;;
  *)
    echo "Usage: $0 <preprod|mainnet> <height>" >&2
    exit 1
    ;;
esac
