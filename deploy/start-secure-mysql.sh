#!/usr/bin/env bash
# 秘密とログが暗号化data EBS上にあることを確認してからDBだけを起動する。
set -Eeuo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
directory=$(dirname "$0")
bash "$directory/check-database-mount.sh" >/dev/null || fail 'DATA_MOUNT_GUARD_FAILED'
[[ -z ${DOCKER_HOST:-} || "$DOCKER_HOST" == unix:///var/run/docker.sock ]] || fail 'REMOTE_DOCKER_FORBIDDEN'
[[ $(docker context inspect --format '{{.Endpoints.docker.Host}}') == unix:///var/run/docker.sock ]] || fail 'REMOTE_DOCKER_FORBIDDEN'
[[ $(docker info --format '{{.CgroupVersion}}') == 2 ]] || fail 'CGROUP_V2_REQUIRED'
for path in "${SITEFLOW_MYSQL_ROOT_PASSWORD_FILE:-}" "${SITEFLOW_MYSQL_CLIENT_CONFIG_FILE:-}" "${SITEFLOW_MYSQL_TLS_DIRECTORY:-}/server-key.pem" "${SITEFLOW_MYSQL_LOG_DIRECTORY:-}"; do
  [[ -n "$path" && -e "$path" ]] || fail 'ENCRYPTED_SECRET_PATH_REQUIRED'
  resolved=$(readlink -f -- "$path") || fail 'SECRET_PATH_UNRESOLVED'
  [[ "$resolved" == "$SITEFLOW_MYSQL_DATA_MOUNT/"* ]] || fail 'SECRET_OUTSIDE_DATA_EBS'
  [[ $(findmnt --noheadings --raw --target "$resolved" --output UUID) == "$SITEFLOW_MYSQL_FS_UUID" ]] || fail 'SECRET_EBS_UUID_MISMATCH'
done
[[ $(stat -c '%a:%u' "$SITEFLOW_MYSQL_ROOT_PASSWORD_FILE") == 600:0 ]] || fail 'ROOT_PASSWORD_PERMISSIONS'
[[ $(stat -c '%a:%u' "$SITEFLOW_MYSQL_CLIENT_CONFIG_FILE") == 400:0 ]] || fail 'ROOT_CLIENT_PERMISSIONS'
[[ $(stat -c '%a:%u' "$SITEFLOW_MYSQL_TLS_DIRECTORY/server-key.pem") == 600:999 ]] || fail 'SERVER_KEY_PERMISSIONS'
docker compose --env-file /dev/null -f "$directory/compose.production.yaml" --profile database config --no-env-resolution --format json |
  python3 -c 'import json,sys; s=json.load(sys.stdin)["services"]["mysql"]; assert s["restart"]=="no" and s["logging"]["driver"]=="none" and s["read_only"] and not s.get("ports"); assert int(s["mem_limit"])==536870912 and int(s["memswap_limit"])==536870912; c=s["ulimits"]["core"]; assert (c.get("hard",0) if isinstance(c,dict) else int(c))==0; assert s["environment"]["MYSQL_ROOT_HOST"]=="localhost"' || fail 'MYSQL_SECURITY_CONFIGURATION_MISMATCH'
exec bash "$directory/start-database.sh"
