#!/usr/bin/env bash
# Run the dashboard journeys against the dfo-apis local stack, then take the stack down.
#
#   DFO_APIS_DIR=/path/to/dfo-apis scripts/local-stack-journeys.sh [python|typescript|both]
#   DFO_APIS_DIR=/path/to/dfo-apis DFO_WEBSITE_DIR=/path/to/dfo-website \
#       scripts/local-stack-journeys.sh proxy
#
# Brings the stack up and seeds it with `just local-stack` in DFO_APIS_DIR, then runs
# python/tests/e2e/test_local_stack.py, typescript/test/e2e/local-stack.local.ts, or both. With
# both, the Python journey writes its ref first, the TypeScript journey reads it and writes its
# own, and the Python crossing test reads that one back.
#
# proxy runs python/tests/e2e/test_website_proxy.py through the website in DFO_WEBSITE_DIR: it
# starts a throwaway Postgres 18 container for the website on 127.0.0.1:55433, migrates it, and
# runs the website's dev server on 127.0.0.1:3000 (the site dfo-apis' local.env names) against
# the stack. The stack and the website share a caller principal and HMAC key generated for the
# run. The dev server's log goes to $DFO_E2E_DIR/website.log, which is removed on exit.
#
# Everything started comes down on exit, pass or fail. Needs Docker, just, uv and Node 22, and
# for proxy the website's dependencies installed (pnpm install).
set -euo pipefail

language="${1:-both}"
case "$language" in
  python | typescript | both | proxy) ;;
  *)
    echo "usage: $0 [python|typescript|both|proxy]" >&2
    exit 2
    ;;
esac
: "${DFO_APIS_DIR:?set DFO_APIS_DIR to the dfo-apis checkout holding scripts/local-stack}"

root="$(cd "$(dirname "$0")/.." && pwd)"
export DFO_BASE_URL="http://127.0.0.1:58083/api"
DFO_E2E_DIR="$(mktemp -d)"
export DFO_E2E_DIR

WEBSITE_PORT=3000
WEBSITE_DB_PORT=55433
WEBSITE_DB_CONTAINER="dfo-journeys-website-db-$$"
website_pid=""

stack() { (cd "$DFO_APIS_DIR" && just local-stack "$1"); }
down() {
  if [ -n "$website_pid" ]; then
    kill "$website_pid" 2>/dev/null || true
    wait "$website_pid" 2>/dev/null || true
  fi
  if [ "$language" = proxy ]; then
    docker rm -f "$WEBSITE_DB_CONTAINER" >/dev/null 2>&1 || true
  fi
  stack down || true
  rm -rf "$DFO_E2E_DIR"
}
trap down EXIT

if [ "$language" = proxy ]; then
  : "${DFO_WEBSITE_DIR:?set DFO_WEBSITE_DIR to the dfo-website checkout}"
  # The stack's uv run reads local.env, where these two are placeholders; the environment wins.
  DFO_CALLER_PRINCIPAL="journeys-$(openssl rand -hex 16)"
  DFO_CALLER_HMAC_KEY="$(openssl rand -hex 32)"
  export DFO_CALLER_PRINCIPAL DFO_CALLER_HMAC_KEY
fi

stack up
stack seed

# The website's dev server in front of the stack, on a throwaway database.
start_website() {
  docker run -d --rm --name "$WEBSITE_DB_CONTAINER" -e POSTGRES_PASSWORD=postgres \
    -p "127.0.0.1:$WEBSITE_DB_PORT:5432" postgres:18 >/dev/null
  local tries=0
  until docker exec "$WEBSITE_DB_CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "the website's Postgres did not start" >&2
      return 1
    fi
    sleep 1
  done
  (cd "$DFO_WEBSITE_DIR" && PGHOST=127.0.0.1 PGPORT="$WEBSITE_DB_PORT" node db/migrate-local.ts)
  # Only the variables named here reach the dev server, so no developer env file applies.
  (cd "$DFO_WEBSITE_DIR" && exec env -i PATH="$PATH" HOME="$HOME" \
    NEXT_TELEMETRY_DISABLED=1 \
    SEARCH_API_BASE=http://127.0.0.1:58083 \
    DATABASE_URL="postgresql://website_runtime:website_runtime_dev_password@127.0.0.1:$WEBSITE_DB_PORT/website" \
    BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
    BETTER_AUTH_URL="http://127.0.0.1:$WEBSITE_PORT" \
    DFO_CALLER_PRINCIPAL="$DFO_CALLER_PRINCIPAL" \
    CALLER_HMAC_KEY="$DFO_CALLER_HMAC_KEY" \
    TRUSTED_PROXY_HOPS=0 \
    RATE_LIMIT_API=100000 \
    ./node_modules/.bin/next dev -H 127.0.0.1 -p "$WEBSITE_PORT") \
    >"$DFO_E2E_DIR/website.log" 2>&1 &
  website_pid=$!
  tries=0
  until curl -sf -o /dev/null "http://127.0.0.1:$WEBSITE_PORT/api/v1/datasets/$1"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ] || ! kill -0 "$website_pid" 2>/dev/null; then
      echo "the website's dev server did not answer; its log:" >&2
      cat "$DFO_E2E_DIR/website.log" >&2
      return 1
    fi
    sleep 1
  done
}

python_journey() {
  (cd "$root/python" && uv run pytest -m live --no-cov -p no:cacheprovider -rxs "$@" \
    tests/e2e/test_local_stack.py)
}

if [ "$language" = proxy ]; then
  # A seeded reading's manifest, read through the proxy, says the site and the stack both answer.
  start_website spec_7f535e528a2a527aa54b316d4eccbb6e/cv_46e66114368dacdffa282c61ee456e0f
  (cd "$root/python" && DFO_WEBSITE_URL="http://127.0.0.1:$WEBSITE_PORT/api/v1" \
    uv run pytest -m live --no-cov -p no:cacheprovider -rxs tests/e2e/test_website_proxy.py)
  exit 0
fi

if [ "$language" != typescript ]; then
  python_journey
fi
if [ "$language" != python ]; then
  (cd "$root/typescript" && node --test test/e2e/local-stack.local.ts)
fi
if [ "$language" = both ]; then
  python_journey -k crossing_reads
fi
