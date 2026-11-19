#!/usr/bin/env bash
# Linuxホスト向け。設定/承認記録は管理者だけが書ける場所で管理する。
set -Eeuo pipefail
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 3 ]] || fail 'USAGE_RELEASE_MANIFEST_SETTINGS_TOKEN'
manifest=$1
settings=$2
token_file=$3
for tool in jq docker curl flock nginx ss; do command -v "$tool" >/dev/null || fail 'MISSING_DEPLOY_TOOL'; done
[[ -f "$manifest" && -f "$settings" ]] || fail 'MISSING_RELEASE_INPUT'
for file in "$manifest" "$settings"; do
  [[ ! -L "$file" && $(stat -c %u "$file") == "$EUID" ]] || fail 'UNTRUSTED_RELEASE_INPUT'
  mode=$(stat -c %a "$file"); (( (8#$mode & 8#022) == 0 )) || fail 'WRITABLE_RELEASE_INPUT'
done
jq -e 'type=="object" and .schemaVersion==1 and .approved==true and .repository=="syucream02/siteflow" and .workflow==".github/workflows/ci.yml" and .imageRepository=="ghcr.io/syucream02/siteflow" and (.sha|test("^[a-f0-9]{40}$")) and (.digest|test("^sha256:[a-f0-9]{64}$")) and (.migrationDigest|test("^sha256:[a-f0-9]{64}$")) and (.runId|test("^[1-9][0-9]*$")) and (.attempt|test("^[1-9][0-9]*$"))' "$manifest" >/dev/null 2>&1 || fail 'INVALID_RELEASE_RECORD'
jq -e '.schemaHash|test("^[a-f0-9]{64}$")' "$manifest" >/dev/null 2>&1 || fail 'INVALID_SCHEMA_HASH'
value() { jq -er --arg key "$1" '.[$key]|select(type=="string" and length>0)' "$settings" 2>/dev/null; }
state=$(value stateDirectory) || fail 'INVALID_SETTINGS'
upstream=$(value upstreamFile) || fail 'INVALID_SETTINGS'
runtime=$(value runtimeEnvFile) || fail 'INVALID_SETTINGS'
ca=$(value caFile) || fail 'INVALID_SETTINGS'
network=$(value network) || fail 'INVALID_SETTINGS'
origin=$(value publicOrigin) || fail 'INVALID_SETTINGS'
for target in "$state" "$upstream" "$runtime" "$ca"; do [[ "$target" == /* && "$target" != *$'\n'* && "$target" != *','* ]] || fail 'ABSOLUTE_PATH_REQUIRED'; done
[[ "$network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && "$origin" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || fail 'INVALID_SETTINGS'
[[ "$network" != host ]] || fail 'HOST_NETWORK_FORBIDDEN'
[[ -d "$state" && -f "$runtime" && -f "$ca" && -f "$upstream" && ! -L "$state" && ! -L "$upstream" ]] || fail 'MISSING_RUNTIME_FILES'
[[ ! -L "$runtime" && $(stat -c %u "$runtime") == "$EUID" ]] || fail 'UNTRUSTED_RUNTIME_FILE'
mode=$(stat -c %a "$runtime"); (( (8#$mode & 8#077) == 0 )) || fail 'PRIVATE_RUNTIME_FILE_REQUIRED'
database_password=$(value databasePasswordFile) || fail 'DATABASE_PASSWORD_FILE_REQUIRED'
auth_secret=$(value authSecretFile) || fail 'AUTH_SECRET_FILE_REQUIRED'
export SITEFLOW_MYSQL_DATA_MOUNT="$(value dataMount)"
export SITEFLOW_MYSQL_FS_UUID="$(value dataFsUuid)"
export SITEFLOW_MYSQL_EBS_VOLUME_ID="$(value dataEbsVolumeId)"
verify_app_secrets() { bash "$(dirname "$0")/check-app-secrets.sh" "$runtime" "$database_password" "$auth_secret" >/dev/null || fail 'APP_SECRET_PROTECTION_FAILED'; }
[[ $(stat -c %u "$state") == "$EUID" ]] || fail 'UNTRUSTED_STATE_DIRECTORY'
mode=$(stat -c %a "$state"); (( (8#$mode & 8#022) == 0 )) || fail 'WRITABLE_STATE_DIRECTORY'
enabled() { [[ -f "$state/enabled" && ! -e "$state/paused" && ! -e "$state/incident.json" ]]; }
enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
exec 9>"$state/release.lock"
flock -n 9 || fail 'RELEASE_BUSY'
enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
current="$state/current.json"
schema="$state/schema.json"
[[ -f "$schema" && ! -L "$schema" && $(stat -c %u "$schema") == "$EUID" ]] || fail 'MIGRATION_RECEIPT_REQUIRED'
mode=$(stat -c %a "$schema"); (( (8#$mode & 8#022) == 0 )) || fail 'WRITABLE_MIGRATION_RECEIPT'
ca_hash=$(sha256sum "$ca"); ca_hash=${ca_hash%% *}
jq -e --arg hash "$(jq -r '.schemaHash' "$manifest")" --arg migration "$(jq -r '.migrationDigest' "$manifest")" --arg db "$(value databaseName)" --arg host "$(value databaseHost)" --arg ca "$ca_hash" \
  '.schemaVersion==1 and .verified==true and .schemaHash==$hash and .migrationDigest==$migration and .databaseName==$db and .databaseHost==$host and .caSha256==$ca' "$schema" >/dev/null || fail 'MIGRATION_RECEIPT_MISMATCH'
jq -e '(.slot=="legacy" and .port==3002) or (.slot=="blue" and .port==3101) or (.slot=="green" and .port==3102)' "$current" >/dev/null 2>&1 || fail 'BOOTSTRAP_STATE_REQUIRED'
old_port=$(jq -r '.port' "$current")
old_slot=$(jq -r '.slot' "$current")
if [[ "$old_slot" == legacy || "$old_slot" == green ]]; then slot=blue; port=3101; else slot=green; port=3102; fi
expected=$(printf 'proxy_pass http://127.0.0.1:%s;\nset $siteflow_slot %s;' "$old_port" "$old_slot")
[[ "$(cat "$upstream")" == "$expected" ]] || fail 'UPSTREAM_STATE_MISMATCH'
sha=$(jq -r '.sha' "$manifest")
image="ghcr.io/syucream02/siteflow@$(jq -r '.digest' "$manifest")"
[[ -z ${DOCKER_HOST:-} || "$DOCKER_HOST" == unix:///var/run/docker.sock ]] || fail 'REMOTE_DOCKER_FORBIDDEN'
permission() {
  [[ -n ${SITEFLOW_CD_PERMISSION_VERSION:-} && ${SITEFLOW_CD_APPROVAL_EXPIRES_EPOCH:-} =~ ^[0-9]+$ ]] || fail 'CD_PERMISSION_CONTEXT_REQUIRED'
  (( $(date -u +%s) < SITEFLOW_CD_APPROVAL_EXPIRES_EPOCH )) || fail 'APPROVAL_EXPIRED_DURING_RELEASE'
  local observed
  observed=$(bash "$(dirname "$0")/check-release-permission.sh" "$token_file") || fail 'RELEASE_PERMISSION_REJECTED'
  [[ "$observed" == "$SITEFLOW_CD_PERMISSION_VERSION" ]] || fail 'RELEASE_PERMISSION_CHANGED'
  (( $(date -u +%s) < SITEFLOW_CD_APPROVAL_EXPIRES_EPOCH )) || fail 'APPROVAL_EXPIRED_DURING_RELEASE'
}
permission
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || fail 'DOCKER_CONTEXT_UNAVAILABLE'
[[ "$endpoint" == unix:///var/run/docker.sock ]] || fail 'REMOTE_DOCKER_FORBIDDEN'
migration_image="ghcr.io/syucream02/siteflow@$(jq -r '.migrationDigest' "$manifest")"
[[ $(docker image inspect "$migration_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null) == "$sha" ]] || fail 'MIGRATION_IMAGE_REVISION_MISMATCH'
verify_app_secrets
# 同じdigestでも、停止・誤ったcontainer・別portを正常配信済みとは扱わない。
# この分岐は確認だけ。再起動やDB操作は復旧の個別承認後に行う。
if [[ "$(jq -r '.image // ""' "$current")" == "$image" ]]; then
  active=$(jq -er '.container|select(test("^siteflow-(blue|green)-[a-f0-9]{12}-r[1-9][0-9]*a[1-9][0-9]*$"))' "$current") || fail 'CURRENT_CONTAINER_NOT_MANAGED'
  [[ $(docker container inspect "$active" --format '{{index .Config.Labels "siteflow.managed"}}' 2>/dev/null) == release ]] || fail 'CURRENT_CONTAINER_NOT_MANAGED'
  [[ $(docker container inspect "$active" --format '{{.Config.Image}}' 2>/dev/null) == "$image" ]] || fail 'CURRENT_IMAGE_MISMATCH'
  [[ $(docker container inspect "$active" --format '{{.State.Running}}' 2>/dev/null) == true ]] || fail 'CURRENT_RELEASE_NOT_RUNNING'
  [[ $(docker container inspect "$active" --format '{{.State.OOMKilled}}' 2>/dev/null) == false ]] || fail 'CURRENT_RELEASE_OOM'
  docker container inspect "$active" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null | \
    jq -e --arg port "$old_port" '.["3000/tcp"]==[{"HostIp":"127.0.0.1","HostPort":$port}]' >/dev/null || fail 'CURRENT_PORT_MISMATCH'
  [[ $(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null) == "$sha" ]] || fail 'CURRENT_REVISION_MISMATCH'
  host=${origin#https://}
  curl --fail --silent --max-time 5 --header "Host: $host" "http://127.0.0.1:$old_port/api/ready" 2>/dev/null | jq -e '.ok==true' >/dev/null || fail 'CURRENT_READINESS_FAILED'
  consecutive=0
  for ((probe=0;probe<10;probe++)); do
    if curl --fail --silent --max-time 5 --dump-header "$state/current-check.headers" --output "$state/current-check.body" "$origin/api/ready" >/dev/null 2>&1 \
      && tr -d '\r' < "$state/current-check.headers" | grep -Fxiq "X-SiteFlow-Slot: $old_slot" \
      && jq -e '.ok==true' "$state/current-check.body" >/dev/null 2>&1; then consecutive=$((consecutive+1)); else consecutive=0; fi
    [[ $consecutive -ge 3 ]] && break
    sleep 1
  done
  rm -f "$state/current-check.headers" "$state/current-check.body"
  [[ $consecutive -ge 3 ]] || fail 'CURRENT_PUBLIC_READINESS_FAILED'
  permission
  printf 'ALREADY_RELEASED_HEALTHY\n'
  exit 0
fi
candidate="siteflow-$slot-${sha:0:12}-r$(jq -r '.runId' "$manifest")a$(jq -r '.attempt' "$manifest")"
cid=''; switched=0; committed=0; rollback_ok=1
transaction=$(mktemp -d "$state/transaction.XXXXXXXX")
cp "$upstream" "$transaction/upstream.before"
route_ready() {
  local expected_slot=$1 route=$2 consecutive=0
  for ((probe=0;probe<10;probe++)); do
    if curl --fail --silent --max-time 5 --dump-header "$transaction/headers" --output "$transaction/body" "$origin$route" >/dev/null 2>&1 \
      && tr -d '\r' < "$transaction/headers" | grep -Fxiq "X-SiteFlow-Slot: $expected_slot" \
      && { [[ "$route" == / ]] || jq -e '.ok==true' "$transaction/body" >/dev/null 2>&1; }; then
      consecutive=$((consecutive+1)); [[ $consecutive -ge 3 ]] && return 0
    else consecutive=0; fi
    sleep 1
  done
  return 1
}
cleanup() {
  status=$?
  trap - EXIT
  if [[ -z "$cid" && -f "$transaction/candidate.id" ]]; then cid=$(cat "$transaction/candidate.id"); fi
  if [[ $committed == 0 && $switched == 1 ]]; then
    if cp "$transaction/upstream.before" "$upstream.restore" && mv "$upstream.restore" "$upstream" && nginx -t >/dev/null 2>&1 && nginx -s reload >/dev/null 2>&1 && route_ready "$old_slot" /; then
      printf 'ROLLED_BACK_TO_PREVIOUS\n' >&2
    else rollback_ok=0; printf 'ROLLBACK_FAILED_KEEP_BOTH_CONTAINERS\n' >&2; fi
  fi
  # 一度公開へ切替を試みた候補は、処理中の接続を壊さないよう自動削除しない。
  if [[ $committed == 0 && $switched == 0 && "$cid" =~ ^[a-f0-9]{64}$ ]]; then docker rm -f "$cid" >/dev/null 2>&1 || true; fi
  if [[ $committed == 0 && $switched == 1 ]]; then
    jq -n --arg container "$candidate" --arg image "$image" --argjson port "$port" --argjson rollback "$rollback_ok" \
      '{container:$container,image:$image,port:$port,rollbackVerified:($rollback==1)}' > "$state/incident.next" && mv "$state/incident.next" "$state/incident.json"
  fi
  # mktempで作成した既知のファイルだけを回収する。DB/volumeは操作しない。
  rm -f "$transaction/upstream.before" "$transaction/upstream.next" "$transaction/current.next" "$transaction/previous.next" "$transaction/candidate.id" "$transaction/headers" "$transaction/body" "$transaction/internal.json"
  rmdir "$transaction" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
docker container inspect "$candidate" >/dev/null 2>&1 && fail 'CANDIDATE_ALREADY_EXISTS'
docker network inspect "$network" >/dev/null 2>&1 || fail 'MISSING_DATABASE_NETWORK'
permission
docker pull "$image" >/dev/null 2>&1 || fail 'IMAGE_PULL_FAILED'
revision=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null) || fail 'IMAGE_INSPECT_FAILED'
[[ "$revision" == "$sha" ]] || fail 'IMAGE_REVISION_MISMATCH'
enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
# 前回残した非公開枠だけを再利用する。既存Vinextや別管理のコンテナは止めない。
if [[ -f "$state/previous.json" ]] && jq -e --argjson port "$port" '.port==$port' "$state/previous.json" >/dev/null; then
  previous=$(jq -r '.container' "$state/previous.json")
  [[ "$previous" =~ ^siteflow-(blue|green)-[a-f0-9]{12}-r[1-9][0-9]*a[1-9][0-9]*$ && "$previous" != "$(jq -r '.container' "$current")" ]] || fail 'PREVIOUS_CONTAINER_NOT_MANAGED'
  managed=$(docker container inspect "$previous" --format '{{index .Config.Labels "siteflow.managed"}}' 2>/dev/null) || fail 'PREVIOUS_CONTAINER_MISSING'
  [[ "$managed" == release ]] || fail 'PREVIOUS_CONTAINER_NOT_MANAGED'
  prior_image=$(docker container inspect "$previous" --format '{{.Config.Image}}' 2>/dev/null) || fail 'PREVIOUS_CONTAINER_UNAVAILABLE'
  [[ "$prior_image" == "$(jq -r '.image' "$state/previous.json")" ]] || fail 'PREVIOUS_IMAGE_MISMATCH'
  running=$(docker container inspect "$previous" --format '{{.State.Running}}' 2>/dev/null) || fail 'PREVIOUS_CONTAINER_UNAVAILABLE'
  if [[ "$running" == true ]]; then
    connections=$(ss -Htn state established "( sport = :$port or dport = :$port )") || fail 'DRAIN_CHECK_UNAVAILABLE'
    [[ -z "$connections" ]] || fail 'PREVIOUS_CONNECTIONS_ACTIVE'
    enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
    permission
    docker stop --time 30 "$previous" >/dev/null 2>&1 || fail 'PREVIOUS_STOP_FAILED'
  fi
fi
enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
verify_app_secrets
permission
cid=$(docker run --detach --cidfile "$transaction/candidate.id" --name "$candidate" --label siteflow.managed=release --network "$network" --env-file "$runtime" \
  --env NODE_ENV=production --env HOSTNAME=0.0.0.0 --env PORT=3000 --env SITEFLOW_WORKSPACE_MODE=public-integrated \
  --env "SITEFLOW_PUBLIC_ORIGIN=$origin" --env SITEFLOW_DB_TLS=required --env SITEFLOW_DB_CA_FILE=/run/siteflow/ca.pem \
  --env "SITEFLOW_DB_HOST=$(value databaseHost)" --env "SITEFLOW_DB_NAME=$(value databaseName)" --env SITEFLOW_DB_PORT=3306 \
  --mount "type=bind,source=$ca,target=/run/siteflow/ca.pem,readonly" --memory 384m --memory-swap 384m \
  --mount "type=bind,source=$database_password,target=/run/secrets/db-password,readonly" \
  --mount "type=bind,source=$auth_secret,target=/run/secrets/auth-secret,readonly" \
  --read-only --ulimit core=0 --tmpfs /tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777 \
  --log-driver none --stop-timeout 30 \
  --restart no --publish "127.0.0.1:$port:3000" "$image" 2>/dev/null) || fail 'CANDIDATE_START_FAILED'
[[ "$cid" =~ ^[a-f0-9]{64}$ ]] || fail 'INVALID_CANDIDATE_ID'
host=${origin#https://}
ready=0
readiness_attempts=$(jq -r '.readinessAttempts // 30' "$settings")
[[ "$readiness_attempts" =~ ^[1-9][0-9]?$ && $readiness_attempts -le 30 ]] || fail 'INVALID_READINESS_ATTEMPTS'
for ((attempt=0;attempt<readiness_attempts;attempt++)); do
  if curl --fail --silent --max-time 3 --header "Host: $host" --output "$transaction/internal.json" "http://127.0.0.1:$port/api/ready" >/dev/null 2>&1 \
    && jq -e '.ok==true' "$transaction/internal.json" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]] || fail 'READINESS_FAILED_KEEP_PREVIOUS'
enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
permission
printf 'proxy_pass http://127.0.0.1:%s;\nset $siteflow_slot %s;\n' "$port" "$slot" > "$transaction/upstream.next"
# 同じファイルシステム上の一時ファイルで置換。失敗時は元のincludeへ戻す。
cp "$transaction/upstream.next" "$upstream.next"
switched=1
mv "$upstream.next" "$upstream"
nginx -t >/dev/null 2>&1 || fail 'NGINX_CONFIG_REJECTED'
enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
permission
nginx -s reload >/dev/null 2>&1 || fail 'NGINX_RELOAD_FAILED'
route_ready "$slot" /api/ready || fail 'PUBLIC_HTTPS_READINESS_FAILED'
enabled || fail 'RELEASE_DISABLED_OR_PAUSED'
permission
jq --arg slot "$slot" --argjson port "$port" --arg image "$image" --arg container "$candidate" '.+{slot:$slot,port:$port,image:$image,container:$container}' "$manifest" > "$transaction/current.next"
cp "$current" "$transaction/previous.next"
mv "$transaction/previous.next" "$state/previous.json"
mv "$transaction/current.next" "$current"
committed=1
printf 'RELEASE_SUCCEEDED_PREVIOUS_RETAINED\n'
