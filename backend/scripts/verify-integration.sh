#!/usr/bin/env bash
# Manual synthetic integration gate. Requires Node 22, PG16 binaries and openssl on PATH.
set -euo pipefail
zone=${1:-UTC}
port=${2:-54316}
out=${3:-/tmp/ezz-integration-results}
mkdir -p "$out"
cluster=$(mktemp -d /tmp/ezz-integration-pg-XXXXXX)
cleanup() { pg_ctl -D "$cluster/data" -m immediate stop > /dev/null 2>&1 || true; rm -rf "$cluster"; }
trap cleanup EXIT
printf '%s\n' fictional-integration-pw > "$cluster/password"
initdb -D "$cluster/data" -U postgres --pwfile="$cluster/password" --auth-host=scram-sha-256 --auth-local=scram-sha-256 -E UTF8 > "$out/initdb.log"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$cluster/data/server.key" -out "$cluster/data/server.crt" -days 2 -subj '/CN=EZZ Fictional Integration' -addext 'subjectAltName=IP:127.0.0.1' > "$out/cert.log" 2>&1
chmod 600 "$cluster/data/server.key"
pg_ctl -D "$cluster/data" -o "-p $port -k $cluster -c listen_addresses=127.0.0.1 -c ssl=on" -l "$cluster/server.log" -w start > "$out/start.log"
export TZ="$zone"
export EZZ_TEST_ADMIN_URL="postgres://postgres:fictional-integration-pw@127.0.0.1:$port/postgres?sslmode=verify-full&sslrootcert=$cluster/data/server.crt"
export EZZ_TEST_TLS_ROOTCERT="$cluster/data/server.crt"
node --version > "$out/versions.log"
postgres --version >> "$out/versions.log"
npm run typecheck > "$out/typecheck.log" 2>&1
# Build once before launching matrix cells; do not rewrite dist during concurrent runs.
test -f dist/test/sprint1-migration-concurrency.test.js
node --test --test-reporter=tap --test-concurrency=1 --test-timeout=60000 test/*.test.ts > "$out/source.log" 2>&1
node --test --test-reporter=tap --test-concurrency=1 --test-timeout=60000 dist/test/*.test.js > "$out/compiled.log" 2>&1
node scripts/demo-visit-journey.ts > "$out/visit-journey.log" 2>&1
node scripts/demo-dentist-encounter.ts > "$out/dentist-journey.log" 2>&1
printf 'PASS %s\n' "$zone"
