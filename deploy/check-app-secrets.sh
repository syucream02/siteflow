#!/usr/bin/env bash
# 秘密の値は読まず、保存先・mode・所有者と非秘密envの形式だけを確認する。
set -Eeuo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 3 ]] || fail 'USAGE_RUNTIME_DB_PASSWORD_AUTH_SECRET'
runtime=$1; database_password=$2; auth_secret=$3
bash "$(dirname "$0")/check-database-mount.sh" >/dev/null || fail 'APP_DATA_MOUNT_NOT_VERIFIED'
for file in "$database_password" "$auth_secret"; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'APP_SECRET_FILE_REQUIRED'
  resolved=$(realpath -- "$file") || fail 'APP_SECRET_PATH_INVALID'
  [[ "$resolved" == "$SITEFLOW_MYSQL_DATA_MOUNT/"* ]] || fail 'APP_SECRET_OUTSIDE_EBS'
  [[ $(findmnt --noheadings --raw --target "$resolved" --output UUID) == "$SITEFLOW_MYSQL_FS_UUID" ]] || fail 'APP_SECRET_UUID_MISMATCH'
  [[ $(stat -c '%a:%u' "$file") == 400:1000 ]] || fail 'APP_SECRET_OWNER_OR_MODE'
  size=$(stat -c %s "$file"); [[ $size -gt 0 && $size -le 4096 ]] || fail 'APP_SECRET_SIZE'
done
db_seen=0; auth_seen=0; user_seen=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" != *$'\r'* && "$line" == *=* ]] || fail 'INVALID_NONSECRET_ENV'
  key=${line%%=*}; value=${line#*=}
  case "$key" in
    SITEFLOW_DB_PASSWORD_FILE) [[ $db_seen == 0 && "$value" == /run/secrets/db-password ]] || fail 'INVALID_DB_PASSWORD_REFERENCE'; db_seen=1 ;;
    SITEFLOW_AUTH_SECRET_FILE) [[ $auth_seen == 0 && "$value" == /run/secrets/auth-secret ]] || fail 'INVALID_AUTH_SECRET_REFERENCE'; auth_seen=1 ;;
    SITEFLOW_DB_USER) [[ $user_seen == 0 && "$value" =~ ^[a-zA-Z0-9_]{1,32}$ && "$value" != root ]] || fail 'INVALID_APP_DB_USER'; user_seen=1 ;;
    NODE_ENV|HOSTNAME|PORT|SITEFLOW_WORKSPACE_MODE|SITEFLOW_PUBLIC_ORIGIN|SITEFLOW_DB_HOST|SITEFLOW_DB_PORT|SITEFLOW_DB_NAME|SITEFLOW_DB_TLS|SITEFLOW_DB_CA_FILE|NEXT_TELEMETRY_DISABLED) ;;
    *) fail 'UNKNOWN_OR_PLAINTEXT_SECRET_ENV' ;;
  esac
done < "$runtime"
[[ $db_seen == 1 && $auth_seen == 1 && $user_seen == 1 ]] || fail 'APP_FILE_SECRET_REFERENCES_REQUIRED'
printf 'APP_SECRET_FILES_VERIFIED\n'
