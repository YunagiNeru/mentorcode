#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

version="$(node -p "require('./package.json').version")"
commit_epoch="$(git show -s --format=%ct HEAD)"
artifact="mentor-code-app-server-${version}.tar.gz"

if [[ ! -f dist/server/server/server.js ]]; then
  echo "App Server build output is missing. Run npm run build:server first." >&2
  exit 1
fi

tar \
  --sort=name \
  --mtime="@${commit_epoch}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -czf "$artifact" \
  dist/server \
  package.json \
  package-lock.json \
  LICENSE.txt

printf '%s\n' "$artifact"
