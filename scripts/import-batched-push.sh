#!/bin/sh
# Client-side batched push — SPEC-0003 §2.7 fallback (no server changes).
#
# For importers who cannot or do not want the async chunked import channel.
# Exploits thin packs: the branch tip advances through topo-ordered commit
# windows so each push transfers only the delta since the previous tip (the
# engine accepts thin packs, SPEC-0001 §5). Every push re-runs connectivity +
# indexing (linear cost in the window count, each window within quota); the
# temporary ref bumps refs_version per window — importer-only edge-cache
# thrash, documented as acceptable.
#
# Usage:
#   scripts/import-batched-push.sh <remote-url> <branch> [window=500]
#
# Properties (SPEC §2.7):
#   - single-threaded by design: concurrent pushes hit the receive lease's
#     503 Retry-After, which git retries — do not parallelize;
#   - repos whose single window still exceeds the per-push quota (huge
#     single-tree blobs) must SHRINK the window;
#   - a crashed run leaves refs/import/batched-tmp at the last good tip; the
#     next run force-overwrites it and the final delete removes it.
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <remote-url> <branch> [window=500]" >&2
  exit 2
fi

remote=$1
branch=$2
window=${3:-500}
tmp=refs/import/batched-tmp

tips=$(mktemp)
trap 'rm -f "$tips"' EXIT

# window = every Nth commit + the final tip (topo-ordered, oldest first so
# each push's thin base is the previous window's tip).
git rev-list --reverse --topo-order "$branch" | awk -v w="$window" 'NR % w == 0' >"$tips"
git rev-parse "$branch" >>"$tips"

while read -r tip; do
  [ -n "$tip" ] || continue
  echo "[batched-push] window tip $tip"
  git push --force "$remote" "+$tip:$tmp"
done <"$tips"

# The real ref lands LAST (one normal push, thin vs the last window tip)…
git push --force "$remote" "+$branch:$branch"
# …and the temporary ref goes away (a failed delete leaves a stale ref the
# next run overwrites; delete it by hand with `git push <remote> ":$tmp"`).
git push --force "$remote" ":$tmp"

echo "[batched-push] done: $branch imported via $(grep -c . "$tips") window(s)"
