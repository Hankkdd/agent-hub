#!/usr/bin/env bash
set -euo pipefail

# From the repository root: mise exec -- bash apps/web/scripts/generate-icons.sh
# The pinned CLI is downloaded to npm's cache; it is not a build dependency.
public_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../public" && pwd)"
for size in 180 192 512; do
  output="icon-${size}.png"
  if [[ "$size" == 180 ]]; then
    output="apple-touch-icon.png"
  fi
  npx --yes sharp-cli@5.2.0 \
    --input "$public_dir/icon.svg" \
    --output "$public_dir/$output" \
    resize "$size" "$size"
done
