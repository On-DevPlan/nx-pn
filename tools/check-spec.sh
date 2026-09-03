#!/usr/bin/env bash
# Spec compliance checks (spec §9.4).
# Fails non-zero if any rule is violated.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

failed=0

check_no_cordis_augmentation_in_core() {
  local hits
  hits=$(rg -n "declare module ['\"]cordis['\"]" packages/core/src/ || true)
  if [ -n "$hits" ]; then
    echo "FAIL: packages/core must have zero cordis Context augmentation (spec §2.4):"
    echo "$hits"
    failed=1
  fi
}

check_no_arrow_register_in_pages() {
  # Pages service will live in packages/client (Plan 3). The rule only applies
  # to the eventual pages service; here we just make sure no proto pages/
  # module has snuck in with an arrow register yet.
  local hits
  hits=$(rg -n 'register\s*=\s*\([^)]*\)\s*=>|register:\s*\(.*\)\s*=>' packages/client/src/pages/ 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "FAIL: pages register must be a prototype method, not an arrow (spec §5.3):"
    echo "$hits"
    failed=1
  fi
}

check_no_cordis_dir_in_core() {
  # Belt-and-braces: the core package must not have a direct cordis import.
  local hits
  hits=$(rg -n "from ['\"]cordis['\"]" packages/core/src/ || true)
  if [ -n "$hits" ]; then
    echo "FAIL: packages/core must not import cordis (spec §3 — pure contracts):"
    echo "$hits"
    failed=1
  fi
}

check_no_cordis_dir_in_core
check_no_cordis_augmentation_in_core
check_no_arrow_register_in_pages

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "spec compliance: OK"
