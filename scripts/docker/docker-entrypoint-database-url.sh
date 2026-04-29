#!/usr/bin/env bash
# Build DATABASE_URL (and optional regional DATABASE_URL_*) from pieces when the full URL
# is not already set. Use this with RDS master secrets that only store username+password
# and rotate every N days, plus static host/port/dbname in task env.
#
# If a given DATABASE_URL* is already non-empty, it is left unchanged (legacy full-URL secrets).
# Passwords are URL-encoded for special characters.
#
# Supported env combinations (per generated URL):
#   DATABASE_URL     <- DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
#   DATABASE_URL_US  <- DB_HOST_US, DB_PORT_US, DB_NAME_US, DB_USER_US, DB_PASSWORD_US
#   (same for _EU, _UK, _AU)
set -euo pipefail

urlencode() {
  node -e "console.log(encodeURIComponent(process.argv[1] || ''))" "${1:-}"
}

# build_if_needed <url_var> <host_var> <port_var> <name_var> <user_var> <pass_var>
build_if_needed() {
  local out_var="$1"
  local host_key="$2"
  local port_key="$3"
  local name_key="$4"
  local user_key="$5"
  local pass_key="$6"

  if [[ -n "${!out_var:-}" ]]; then
    return 0
  fi

  local host="${!host_key:-}"
  local port="${!port_key:-5432}"
  local dbname="${!name_key:-}"
  local user="${!user_key:-}"
  local pass="${!pass_key:-}"

  if [[ -z "$host" || -z "$dbname" || -z "$user" || -z "$pass" ]]; then
    return 0
  fi

  local enc_pass
  enc_pass="$(urlencode "$pass")"
  local url="postgresql://${user}:${enc_pass}@${host}:${port}/${dbname}?sslmode=require"
  printf -v "$out_var" '%s' "$url"
  export "$out_var"
}

build_if_needed "DATABASE_URL" "DB_HOST" "DB_PORT" "DB_NAME" "DB_USER" "DB_PASSWORD"

build_if_needed "DATABASE_URL_US" "DB_HOST_US" "DB_PORT_US" "DB_NAME_US" "DB_USER_US" "DB_PASSWORD_US"
build_if_needed "DATABASE_URL_EU" "DB_HOST_EU" "DB_PORT_EU" "DB_NAME_EU" "DB_USER_EU" "DB_PASSWORD_EU"
build_if_needed "DATABASE_URL_UK" "DB_HOST_UK" "DB_PORT_UK" "DB_NAME_UK" "DB_USER_UK" "DB_PASSWORD_UK"
build_if_needed "DATABASE_URL_AU" "DB_HOST_AU" "DB_PORT_AU" "DB_NAME_AU" "DB_USER_AU" "DB_PASSWORD_AU"

exec "$@"
