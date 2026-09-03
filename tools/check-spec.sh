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

check_no_browser_globals_in_host() {
  # Spec §4: the host package runs on Node. Referencing the browser DOM
  # globals (window/document/Blob/URL.createObjectURL) in host source
  # means code that can never run server-side slipped into the runtime.
  # Test files may use them where the browser half is simulated, but
  # host *src* must not.
  local hits
  hits=$(rg -n '\b(window|document|navigator)\b|createObjectURL|localStorage|sessionStorage' \
    packages/host/src --glob '!**/__tests__/**' || true)
  if [ -n "$hits" ]; then
    echo "FAIL: packages/host/src must not reference browser-only globals (spec §4 — Node runtime):"
    echo "$hits"
    failed=1
  fi
}

check_no_browser_globals_in_host

check_no_undici_imports_in_core() {
  # core is a pure contract layer with zero runtime deps beyond ajv;
  # undici (host's HTTP client) must never be imported there.
  local hits
  hits=$(rg -n "from ['\"]undici['\"]|import\(['\"]undici['\"]\)" packages/core/src/ || true)
  if [ -n "$hits" ]; then
    echo "FAIL: packages/core must not import undici (spec §3 — pure contracts):"
    echo "$hits"
    failed=1
  fi
}

check_no_undici_imports_in_core

check_no_node_builtins_in_client_src() {
  # Spec §5: packages/client is the *browser* runtime. Node builtin imports
  # (node:fs, node:path, ws, …) in client src would break browser bundling.
  # Test files may import Node builtins where they simulate the browser.
  local hits
  hits=$(rg -n "from ['\"]node:|from ['\"]ws['\"]|from ['\"]undici['\"]" \
    packages/client/src --glob '!**/__tests__/**' || true)
  if [ -n "$hits" ]; then
    echo "FAIL: packages/client/src must not import Node builtins (spec §5 — browser runtime):"
    echo "$hits"
    failed=1
  fi
}

check_no_node_builtins_in_client_src

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "spec compliance: OK"
