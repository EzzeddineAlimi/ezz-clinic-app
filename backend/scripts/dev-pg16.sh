#!/usr/bin/env bash
# Throwaway local PostgreSQL 16 cluster for development and tests, WITHOUT docker (R73-B). Fictional data only.
#   scripts/dev-pg16.sh start   -> prints the EZZ_TEST_ADMIN_URL to export
#   scripts/dev-pg16.sh stop    -> stops it and deletes the data directory
# Needs the PostgreSQL 16 server binaries (Ubuntu: apt install postgresql-16). As root, runs them as user postgres.
set -euo pipefail
DIR=${EZZ_DEV_PG_DIR:-/tmp/ezz-dev-pg16}
PORT=${EZZ_DEV_PG_PORT:-54316}
PW=fictional-dev-superuser-pw
BIN=$( [ -x /usr/lib/postgresql/16/bin/initdb ] && echo /usr/lib/postgresql/16/bin || pg_config --bindir )
run() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"; [ "$(id -u)" = 0 ] && chown postgres:postgres "$DIR"
      echo "$PW" > "$DIR/pw"; [ "$(id -u)" = 0 ] && chown postgres "$DIR/pw"
      run "$BIN/initdb" -D "$DIR/data" -U postgres --pwfile "$DIR/pw" --auth-host=scram-sha-256 --auth-local=peer -E UTF8 --no-instructions >/dev/null
    fi
    run "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -w -l "$DIR/log" start >/dev/null
    echo "export EZZ_TEST_ADMIN_URL=postgres://postgres:$PW@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    [ -d "$DIR/data" ] && run "$BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null || true
    rm -rf "$DIR"
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2;;
esac
