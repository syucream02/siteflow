#!/usr/bin/env bash
# 手動復旧用。実EC2でのrestartは未実施。旧公開/DB削除/初期化は扱わない。
set -Eeuo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
mode=${1:-status}; record=${2:-}
[[ "$mode" == status || "$mode" == restart-db || "$mode" == restart-candidate || "$mode" == stop-candidate ]] || fail 'INVALID_RECOVERY_MODE'
if [[ "$mode" != status ]]; then [[ ${SITEFLOW_RECOVERY_APPROVED:-} == yes ]] || fail 'RECOVERY_APPROVAL_REQUIRED'; fi
[[ $EUID == 0 && -f /etc/siteflow/mysql-host.env && ! -L /etc/siteflow/mysql-host.env ]] || fail 'TRUSTED_HOST_SETTINGS_REQUIRED'
[[ $(stat -c '%a:%u' /etc/siteflow/mysql-host.env) == 600:0 ]] || fail 'HOST_SETTINGS_PERMISSIONS'
set -a
source /etc/siteflow/mysql-host.env
set +a
directory=$(dirname "$0")
bash "$directory/check-database-mount.sh" >/dev/null || fail 'RECOVERY_MOUNT_UNVERIFIED'
[[ "$record" == /srv/siteflow-mysql/config/candidate-*/result.json && -f "$record" && ! -L "$record" && $(stat -c %u "$record") == 0 ]] || fail 'CANDIDATE_RECORD_REQUIRED'
[[ "$(realpath "$record")" == "$record" ]] || fail 'CANDIDATE_RECORD_PATH'
cid=$(jq -er '.candidateContainer|select(test("^[a-f0-9]{64}$"))' "$record") || fail 'INVALID_CANDIDATE_RECORD'
image=$(jq -er '.appImageId|select(test("^sha256:[a-f0-9]{64}$"))' "$record") || fail 'INVALID_IMAGE_RECORD'
[[ $(docker inspect "$cid" --format '{{index .Config.Labels "siteflow.purpose"}}') == next-candidate && $(docker inspect "$cid" --format '{{.Image}}') == "$image" ]] || fail 'CANDIDATE_IDENTITY_MISMATCH'
[[ $(docker inspect "$cid" --format '{{.HostConfig.RestartPolicy.Name}}') == no ]] || fail 'CANDIDATE_RESTART_BYPASSES_GUARD'
runtime="$(dirname "$record")/candidate-runtime.env"
bash "$directory/check-app-secrets.sh" "$runtime" /srv/siteflow-mysql/secrets/candidate/db-password /srv/siteflow-mysql/secrets/candidate/auth-secret >/dev/null || fail 'RECOVERY_SECRETS_UNVERIFIED'
if [[ "$mode" == status ]]; then
  docker inspect "$cid" --format 'candidate running={{.State.Running}} oom={{.State.OOMKilled}}'
  systemctl is-active siteflow-mysql.service
  exit 0
fi
was_running=$(docker inspect "$cid" --format '{{.State.Running}}')
[[ "$was_running" == false ]] || docker stop --time 30 "$cid" >/dev/null || fail 'CANDIDATE_STOP_FAILED'
if [[ "$mode" == restart-db ]]; then
  systemctl restart siteflow-mysql.service || fail 'DB_RESTART_FAILED_KEEP_CANDIDATE_STOPPED'
  ready=0
  for ((n=0;n<90;n++)); do
    if [[ $(docker inspect siteflow-production-mysql-1 --format '{{.State.Health.Status}}') == healthy ]]; then ready=1; break; fi
    sleep 1
  done
  [[ $ready == 1 ]] || fail 'DB_UNHEALTHY_KEEP_CANDIDATE_STOPPED'
fi
if [[ "$mode" == restart-candidate || ( "$mode" == restart-db && "$was_running" == true ) ]]; then
  bash "$directory/check-app-secrets.sh" "$runtime" /srv/siteflow-mysql/secrets/candidate/db-password /srv/siteflow-mysql/secrets/candidate/auth-secret >/dev/null || fail 'RECOVERY_SECRETS_UNVERIFIED'
  docker start "$cid" >/dev/null || fail 'CANDIDATE_START_FAILED'
  ready=0
  for ((n=0;n<60;n++)); do
    if curl --fail --silent --max-time 3 --header 'Host: 13.237.188.172' http://127.0.0.1:3001/api/ready | jq -e '.ok==true' >/dev/null; then ready=1; break; fi
    sleep 1
  done
  if [[ $ready != 1 ]]; then docker stop --time 30 "$cid" >/dev/null || true; fail 'CANDIDATE_NOT_READY_STOPPED'; fi
fi
curl --fail --silent --show-error --max-time 10 --output /dev/null https://13.237.188.172 || fail 'LEGACY_HTTPS_FAILED'
printf 'RECOVERY_ACTION_FINISHED_VERIFY_READINESS_AND_SAVED_DATA\n'
