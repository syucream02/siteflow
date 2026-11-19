#!/usr/bin/env bash
# 既存DBの再開が既定。初期化の明示許可なしに空volumeでMySQLを起動しない。
set -Eeuo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${SITEFLOW_MYSQL_IMAGE:-} =~ ^mysql@sha256:[a-f0-9]{64}$ ]] || fail 'MYSQL_DIGEST_REQUIRED'
[[ ${SITEFLOW_MYSQL_VOLUME:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'VOLUME_REQUIRED'
[[ ${SITEFLOW_DATABASE_NETWORK:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'NETWORK_REQUIRED'
if [[ -n ${SITEFLOW_MYSQL_DATA_MOUNT:-}${SITEFLOW_MYSQL_EBS_VOLUME_ID:-}${SITEFLOW_MYSQL_FS_UUID:-} ]]; then
  bash "$(dirname "$0")/check-database-mount.sh" || fail 'DATA_MOUNT_GUARD_FAILED'
fi
[[ -z ${DOCKER_HOST:-} || "$DOCKER_HOST" == unix:///var/run/docker.sock ]] || fail 'REMOTE_DOCKER_FORBIDDEN'
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || fail 'DOCKER_CONTEXT_UNAVAILABLE'
[[ "$endpoint" == unix:///var/run/docker.sock ]] || fail 'REMOTE_DOCKER_FORBIDDEN'
purpose=$(docker volume inspect "$SITEFLOW_MYSQL_VOLUME" --format '{{index .Labels "siteflow.purpose"}}' 2>/dev/null) || fail 'EXISTING_VOLUME_REQUIRED'
[[ "$purpose" == production-db ]] || fail 'VOLUME_OWNERSHIP_MISMATCH'
# 追加データEBSを使う場合、未mountの空dirへの初期化を拒否する。
# 既存のローカルnamed volume試験では両方未指定のまま使用する。
if [[ -n ${SITEFLOW_MYSQL_DATA_MOUNT:-}${SITEFLOW_MYSQL_EBS_VOLUME_ID:-} ]]; then
  driver=$(docker volume inspect "$SITEFLOW_MYSQL_VOLUME" --format '{{.Driver}}') || fail 'VOLUME_DRIVER_UNAVAILABLE'
  device=$(docker volume inspect "$SITEFLOW_MYSQL_VOLUME" --format '{{index .Options "device"}}') || fail 'VOLUME_DEVICE_UNAVAILABLE'
  options=$(docker volume inspect "$SITEFLOW_MYSQL_VOLUME" --format '{{index .Options "o"}}') || fail 'VOLUME_OPTIONS_UNAVAILABLE'
  type=$(docker volume inspect "$SITEFLOW_MYSQL_VOLUME" --format '{{index .Options "type"}}') || fail 'VOLUME_TYPE_UNAVAILABLE'
  [[ "$driver" == local && "$type" == none && "$options" == bind && "$device" == "$SITEFLOW_MYSQL_DATA_MOUNT/mysql" ]] || fail 'DATA_VOLUME_BIND_MISMATCH'
fi
purpose=$(docker network inspect "$SITEFLOW_DATABASE_NETWORK" --format '{{index .Labels "siteflow.purpose"}}' 2>/dev/null) || fail 'EXISTING_NETWORK_REQUIRED'
[[ "$purpose" == production-db ]] || fail 'NETWORK_OWNERSHIP_MISMATCH'
if [[ ${SITEFLOW_DATABASE_INITIALIZE_APPROVED:-} == yes ]]; then
  check='test -z "$(ls -A /var/lib/mysql)"'
else
  check='test -s /var/lib/mysql/auto.cnf && test -d /var/lib/mysql/mysql'
fi
docker run --rm --pull=never --network none --read-only --log-driver none --memory 64m --memory-swap 64m --ulimit core=0 \
  --mount "type=volume,source=$SITEFLOW_MYSQL_VOLUME,target=/var/lib/mysql,readonly" \
  --entrypoint sh "$SITEFLOW_MYSQL_IMAGE" -c "$check" >/dev/null 2>&1 || fail 'DATABASE_MODE_OR_CONTENT_MISMATCH'
file="$(dirname "$0")/compose.production.yaml"
docker compose -f "$file" --profile database config --quiet >/dev/null 2>&1 || fail 'COMPOSE_CONFIG_INVALID'
docker compose -f "$file" --profile database up --detach --no-deps mysql >/dev/null 2>&1 || fail 'MYSQL_START_FAILED'
printf 'MYSQL_STARTED_DATA_RETAINED\n'
