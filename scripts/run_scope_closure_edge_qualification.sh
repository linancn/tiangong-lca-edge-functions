#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec deno run \
  --allow-env \
  --allow-net=127.0.0.1,localhost \
  --allow-read \
  --allow-run=git \
  --allow-write \
  --config "$script_dir/../supabase/functions/deno.json" \
  "$script_dir/scope_closure_edge_qualification.ts" "$@"
