#!/usr/bin/env bash
# 現在のproduction変数を都度取得する。資格情報はargv/Env/出力へ展開しない。
set -Eeuo pipefail
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 1 ]] || fail 'USAGE_RELEASE_TOKEN_FILE'
token_file=$1
[[ -f "$token_file" && ! -L "$token_file" && $(stat -c '%a:%u' "$token_file") == "600:$EUID" ]] || fail 'UNTRUSTED_RELEASE_TOKEN'
bash "$(dirname "$0")/check-database-mount.sh" >/dev/null || fail 'PERMISSION_EBS_NOT_VERIFIED'
resolved=$(realpath -- "$token_file") || fail 'TOKEN_PATH_INVALID'
[[ "$resolved" == "$SITEFLOW_MYSQL_DATA_MOUNT/"* && $(findmnt --noheadings --raw --target "$resolved" --output UUID) == "$SITEFLOW_MYSQL_FS_UUID" ]] || fail 'TOKEN_OUTSIDE_ENCRYPTED_EBS'
cgroup_path=$(awk -F: '$1=="0"{print $3}' /proc/self/cgroup)
[[ "$cgroup_path" == /* && "$cgroup_path" != *..* && $(cat "/sys/fs/cgroup$cgroup_path/memory.swap.max") == 0 && $(ulimit -c) == 0 ]] || fail 'PERMISSION_NO_SWAP_CORE_REQUIRED'
token=$(cat "$token_file")
[[ "$token" =~ ^[a-zA-Z0-9_]+$ ]] || fail 'INVALID_RELEASE_TOKEN'
# キャッシュ済みの成功値にフォールバックしない。401/403/404/5xx/timeoutはすべて拒否。
response=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --config - --proto '=https' --tlsv1.2 --fail --silent --max-time 10 --max-filesize 16384 --write-out $'\n%{http_code}' \
  --header 'Accept: application/vnd.github+json' --header 'Cache-Control: no-cache' --header 'X-GitHub-Api-Version: 2022-11-28' \
  'https://api.github.com/repos/syucream02/siteflow/environments/production/variables/SITEFLOW_RELEASE_ENABLED' 2>/dev/null) || fail 'RELEASE_PERMISSION_UNAVAILABLE'
[[ "$response" == *$'\n'* && ${response##*$'\n'} == 200 ]] || fail 'RELEASE_PERMISSION_HTTP_STATUS'
body=${response%$'\n'*}
version=$(jq -er 'select(type=="object" and .name=="SITEFLOW_RELEASE_ENABLED" and .value=="true")|.updated_at|select(type=="string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))' <<< "$body" 2>/dev/null) || fail 'RELEASE_PERMISSION_NOT_TRUE'
epoch=$(date -u -d "$version" +%s 2>/dev/null) || fail 'RELEASE_PERMISSION_VERSION_INVALID'
[[ "$epoch" -le $(date -u +%s) ]] || fail 'RELEASE_PERMISSION_VERSION_IN_FUTURE'
printf '%s\n' "$version"
