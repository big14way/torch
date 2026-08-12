#!/bin/sh
# Render the proxy config from the environment at boot.
#
# The upstream image expects a config file at /app/config/config.toml, and that
# file carries the indexer database password. Baking it into an image means the
# credential travels wherever the image does — including into a registry. So the
# image ships a template with placeholders and the values arrive as env vars,
# which is also what lets the same image run locally and on a host.
set -eu

: "${DB_HOST:?DB_HOST is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASS:?DB_PASS is required}"
: "${REDIS_ADDR:=redis:6379}"

sed \
  -e "s|__DB_HOST__|${DB_HOST}|g" \
  -e "s|__DB_USER__|${DB_USER}|g" \
  -e "s|__DB_PASS__|${DB_PASS}|g" \
  -e "s|__REDIS_ADDR__|${REDIS_ADDR}|g" \
  /app/config/config.template.toml > /app/config/config.toml

# Never let the rendered file linger in a layer or a log.
chmod 600 /app/config/config.toml
exec "$@"
