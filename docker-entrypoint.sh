#!/bin/sh
set -e

# A freshly-mounted persistent volume (e.g. Coolify Storage) arrives owned by
# root, which the non-root `node` user can't write to — causing EACCES when the
# store tries to persist conversations. We start as root, make DATA_DIR writable
# by `node`, then drop privileges to run the app.
DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec gosu node "$@"
fi

# Already unprivileged (e.g. a platform that forces a user) — just run.
exec "$@"
