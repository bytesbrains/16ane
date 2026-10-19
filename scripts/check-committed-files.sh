#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# 16ane Protocol - Committed-files check
# Refuses files that should never reach the repo's history: local tool state,
# files .gitignore excludes, unexpected binaries and very large files.
# ----------------------------------------------------------------------------

set -euo pipefail

MAX_BYTES=$((2 * 1024 * 1024))
STATE_RE='(^|/)\.(wrangler|miniflare)/|\.(sqlite3?|db)(-wal|-shm|-journal)?$'
BINARY_OK_RE='^(assets|web)/.*\.(png|ico|jpe?g|webp|gif)$'

[[ $# -gt 0 ]] || { echo "usage: $0 <rev-list arguments, e.g. origin/main..HEAD>" >&2; exit 2; }

problems=()
commits=$(git rev-list --no-merges "$@")
for c in $commits; do
  short=$(git rev-parse --short "$c")
  while IFS=$'\t' read -r -d '' added _ path; do
    [[ -n "$path" ]] || continue
    [[ "$(git --literal-pathspecs ls-tree "$c" -- "$path" | awk '{print $1}')" == 160000 ]] && continue
    if [[ "$path" =~ $STATE_RE ]]; then
      problems+=("$short $path: local tool state (a database or wrangler/miniflare store)")
    elif git check-ignore -q --no-index -- "$path"; then
      problems+=("$short $path: matches .gitignore (force-added?)")
    elif [[ "$added" == "-" && ! "$path" =~ $BINARY_OK_RE ]]; then
      problems+=("$short $path: binary file outside assets/ and web/ images")
    fi
    size=$(git cat-file -s "$c:$path")
    (( size <= MAX_BYTES )) || problems+=("$short $path: $size bytes, over the $MAX_BYTES-byte limit")
  done < <(git diff-tree -r --root --no-commit-id --no-renames --diff-filter=ACMR -z --numstat "$c")
done

if (( ${#problems[@]} )); then
  echo "ERROR: These commits add or change files that should not be in the repo's history:"
  printf '   %s\n' "${problems[@]}"
  exit 1
fi
echo "OK: $(wc -w <<< "$commits" | tr -d ' ') commit(s) checked: no local state, ignored, unexpected binary or oversized files."
