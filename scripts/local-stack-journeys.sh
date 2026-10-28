#!/usr/bin/env bash
# Run the dashboard journeys against the dfo-apis local stack, then take the stack down.
#
#   DFO_APIS_DIR=/path/to/dfo-apis scripts/local-stack-journeys.sh [python|typescript|both]
#
# Brings the stack up and seeds it with `just local-stack` in DFO_APIS_DIR, then runs
# python/tests/e2e/test_local_stack.py, typescript/test/e2e/local-stack.local.ts, or both. With
# both, the Python journey writes its ref first, the TypeScript journey reads it and writes its
# own, and the Python crossing test reads that one back. The stack comes down on exit, pass or
# fail. Needs Docker, just, uv and Node 22.
set -euo pipefail

language="${1:-both}"
case "$language" in
  python | typescript | both) ;;
  *)
    echo "usage: $0 [python|typescript|both]" >&2
    exit 2
    ;;
esac
: "${DFO_APIS_DIR:?set DFO_APIS_DIR to the dfo-apis checkout holding scripts/local-stack}"

root="$(cd "$(dirname "$0")/.." && pwd)"
export DFO_BASE_URL="http://127.0.0.1:58083/api"
DFO_E2E_DIR="$(mktemp -d)"
export DFO_E2E_DIR

stack() { (cd "$DFO_APIS_DIR" && just local-stack "$1"); }
down() {
  stack down || true
  rm -rf "$DFO_E2E_DIR"
}
trap down EXIT

stack up
stack seed

python_journey() {
  (cd "$root/python" && uv run pytest -m live --no-cov -p no:cacheprovider -rxs "$@" \
    tests/e2e/test_local_stack.py)
}

if [ "$language" != typescript ]; then
  python_journey
fi
if [ "$language" != python ]; then
  (cd "$root/typescript" && node --test test/e2e/local-stack.local.ts)
fi
if [ "$language" = both ]; then
  python_journey -k crossing_reads
fi
