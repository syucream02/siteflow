#!/usr/bin/env bash
# 既存タイマーへの適用は別承認。GitHubを照会するのはEC2への適用後のみ。
set -Eeuo pipefail
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 2 ]] || fail 'USAGE_CD_SETTINGS_TOKEN_FILE'
settings=$1; token_file=$2
for tool in curl jq unzip flock date; do command -v "$tool" >/dev/null || fail 'MISSING_CD_TOOL'; done
for file in "$settings" "$token_file"; do
  [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == "$EUID" ]] || fail 'UNTRUSTED_CD_INPUT'
  mode=$(stat -c %a "$file"); (( (8#$mode & 8#022) == 0 )) || fail 'WRITABLE_CD_INPUT'
done
mode=$(stat -c %a "$token_file"); (( (8#$mode & 8#077) == 0 )) || fail 'PRIVATE_TOKEN_FILE_REQUIRED'
state=$(jq -er '.stateDirectory' "$settings") || fail 'INVALID_SETTINGS'
[[ "$state" == /* && -d "$state" && -f "$state/enabled" && ! -e "$state/paused" && ! -e "$state/incident.json" && -f "$token_file" ]] || fail 'CD_DISABLED_OR_PAUSED'
[[ ! -L "$state" && $(stat -c %u "$state") == "$EUID" ]] || fail 'UNTRUSTED_STATE_DIRECTORY'
mode=$(stat -c %a "$state"); (( (8#$mode & 8#022) == 0 )) || fail 'WRITABLE_STATE_DIRECTORY'
exec 8>"$state/cd.lock"
flock -n 8 || fail 'CD_BUSY'
export SITEFLOW_MYSQL_DATA_MOUNT="$(jq -er '.dataMount' "$settings")"
export SITEFLOW_MYSQL_FS_UUID="$(jq -er '.dataFsUuid' "$settings")"
export SITEFLOW_MYSQL_EBS_VOLUME_ID="$(jq -er '.dataEbsVolumeId' "$settings")"
bash "$(dirname "$0")/check-database-mount.sh" >/dev/null || fail 'CD_DATA_MOUNT_NOT_VERIFIED'
resolved_token=$(realpath -- "$token_file") || fail 'TOKEN_PATH_INVALID'
[[ "$resolved_token" == "$SITEFLOW_MYSQL_DATA_MOUNT/"* ]] || fail 'TOKEN_OUTSIDE_ENCRYPTED_EBS'
[[ $(findmnt --noheadings --raw --target "$resolved_token" --output UUID) == "$SITEFLOW_MYSQL_FS_UUID" ]] || fail 'TOKEN_EBS_UUID_MISMATCH'
cgroup_path=$(awk -F: '$1=="0"{print $3}' /proc/self/cgroup)
[[ "$cgroup_path" == /* && "$cgroup_path" != *..* ]] || fail 'CD_CGROUP_PATH_INVALID'
# host上のsystemd unitと、namespace付きDockerの両方で自分のgroupを読む。
cgroup_directory="/sys/fs/cgroup$cgroup_path"
[[ -r "$cgroup_directory/memory.swap.max" && $(cat "$cgroup_directory/memory.swap.max") == 0 && $(ulimit -c) == 0 ]] || fail 'CD_NO_SWAP_CORE_PROTECTION_REQUIRED'
token=$(cat "$token_file")
[[ "$token" =~ ^[a-zA-Z0-9_]+$ ]] || fail 'INVALID_TOKEN_FILE'
temporary=$(mktemp -d "$state/cd.XXXXXXXX")
cleanup() { rm -f "$temporary/environment.json" "$temporary/branches.json" "$temporary/reviews.json" "$temporary/main.json" "$temporary/runs.json" "$temporary/jobs.json" "$temporary/artifacts.json" "$temporary/artifact.zip" "$temporary/approved-release.json"; rmdir "$temporary" 2>/dev/null || true; }
trap cleanup EXIT
api() { printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --config - --fail --silent --show-error --max-time 30 --max-filesize 2097152 --header 'Accept: application/vnd.github+json' --header 'X-GitHub-Api-Version: 2022-11-28' "https://api.github.com/repos/syucream02/siteflow/$1" > "$2" 2>/dev/null; }
permission_version=$(bash "$(dirname "$0")/check-release-permission.sh" "$token_file") || fail 'CD_RELEASE_PERMISSION_REJECTED'
api 'environments/production' "$temporary/environment.json" || fail 'PRODUCTION_ENVIRONMENT_UNAVAILABLE'
jq -e '.can_admins_bypass==false' "$temporary/environment.json" >/dev/null || fail 'ADMIN_BYPASS_MUST_BE_DISABLED'
jq -e '[.protection_rules[]?|select(.type=="required_reviewers" and .prevent_self_review==false and (.reviewers|length)==1 and .reviewers[0].type=="User" and .reviewers[0].reviewer.login=="syucream02")]|length==1' "$temporary/environment.json" >/dev/null || fail 'REQUIRED_OWNER_REVIEW_NOT_CONFIGURED'
jq -e '.deployment_branch_policy.protected_branches==false and .deployment_branch_policy.custom_branch_policies==true' "$temporary/environment.json" >/dev/null || fail 'PRODUCTION_BRANCH_POLICY_UNSAFE'
api 'environments/production/deployment-branch-policies' "$temporary/branches.json" || fail 'BRANCH_POLICY_UNAVAILABLE'
jq -e '.total_count==1 and (.branch_policies|length)==1 and .branch_policies[0].name=="main" and ((.branch_policies[0].type // "branch")=="branch")' "$temporary/branches.json" >/dev/null || fail 'MAIN_ONLY_DEPLOYMENT_REQUIRED'
api 'git/ref/heads/main' "$temporary/main.json" || fail 'GITHUB_MAIN_UNAVAILABLE'
sha=$(jq -er '.object.sha|select(test("^[a-f0-9]{40}$"))' "$temporary/main.json") || fail 'INVALID_MAIN_SHA'
api 'actions/workflows/ci.yml/runs?branch=main&event=push&per_page=30' "$temporary/runs.json" || fail 'GITHUB_RUNS_UNAVAILABLE'
# 最新の一致runが失敗なら、過去の成功へ戻らない。
run=$(jq -ec --arg sha "$sha" '[.workflow_runs[]|select(.head_sha==$sha)]|sort_by(.id)|last|select(.event=="push" and .head_branch=="main" and .repository.full_name=="syucream02/siteflow" and .head_repository.full_name=="syucream02/siteflow" and .path==".github/workflows/ci.yml" and .status=="completed" and .conclusion=="success")' "$temporary/runs.json") || fail 'NO_APPROVED_MAIN_RUN'
id=$(jq -r '.id|tostring' <<< "$run"); attempt=$(jq -r '.run_attempt|tostring' <<< "$run")
[[ "$id" =~ ^[1-9][0-9]*$ && "$attempt" =~ ^[1-9][0-9]*$ ]] || fail 'INVALID_RUN_ID'
# job名だけでは承認の証明にしない。GitHubに残る本人のproduction承認も照合する。
environment_id=$(jq -er '.id|numbers' "$temporary/environment.json") || fail 'PRODUCTION_ID_REQUIRED'
api "actions/runs/$id/approvals" "$temporary/reviews.json" || fail 'REVIEW_HISTORY_UNAVAILABLE'
jq -e --argjson eid "$environment_id" '[.[]|select(any(.environments[]?; .id==$eid and .name=="production"))]|last|select(.state=="approved" and .user.login=="syucream02")' "$temporary/reviews.json" >/dev/null || fail 'EXPLICIT_OWNER_APPROVAL_MISSING'
api "actions/runs/$id/jobs?filter=latest&per_page=100" "$temporary/jobs.json" || fail 'GITHUB_JOBS_UNAVAILABLE'
jq -e '[.jobs[]|select(.name=="release-approved" and .status=="completed" and .conclusion=="success")]|length==1' "$temporary/jobs.json" >/dev/null || fail 'APPROVAL_JOB_NOT_SUCCESSFUL'
api "actions/runs/$id/artifacts?per_page=100" "$temporary/artifacts.json" || fail 'GITHUB_ARTIFACTS_UNAVAILABLE'
artifact=$(jq -er --arg name "approved-release-$sha-$id-$attempt" '[.artifacts[]|select(.name==$name and .expired==false)]|select(length==1)|.[0].id|tostring' "$temporary/artifacts.json") || fail 'APPROVAL_ARTIFACT_MISSING'
[[ "$artifact" =~ ^[1-9][0-9]*$ ]] || fail 'INVALID_ARTIFACT_ID'
created=$(jq -er --argjson id "$artifact" '.artifacts[]|select(.id==$id)|.created_at|select(type=="string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))' "$temporary/artifacts.json") || fail 'APPROVAL_TIME_REQUIRED'
created_epoch=$(date -u -d "$created" +%s 2>/dev/null) || fail 'INVALID_APPROVAL_TIME'
now=$(date -u +%s)
(( now >= created_epoch && now - created_epoch < 3600 )) || fail 'APPROVAL_OUTSIDE_ONE_HOUR'
permission_epoch=$(date -u -d "$permission_version" +%s) || fail 'INVALID_PERMISSION_TIME'
(( permission_epoch < created_epoch )) || fail 'APPROVAL_PREDATES_PERMISSION_CHANGE'
printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --config - --location --fail --silent --max-time 30 --max-filesize 131072 "https://api.github.com/repos/syucream02/siteflow/actions/artifacts/$artifact/zip" > "$temporary/artifact.zip" 2>/dev/null || fail 'ARTIFACT_DOWNLOAD_FAILED'
unzip -p "$temporary/artifact.zip" approved-release.json | head -c 16385 > "$temporary/approved-release.json" || fail 'ARTIFACT_READ_FAILED'
[[ $(wc -c < "$temporary/approved-release.json") -le 16384 ]] || fail 'ARTIFACT_TOO_LARGE'
jq -e --arg sha "$sha" --arg id "$id" --arg attempt "$attempt" '.sha==$sha and .runId==$id and .attempt==$attempt' "$temporary/approved-release.json" >/dev/null || fail 'ARTIFACT_RUN_MISMATCH'
# API取得中にmainが進んだ場合も中止する。休止状態はrelease.shでも再確認。
api 'git/ref/heads/main' "$temporary/main.json" || fail 'GITHUB_MAIN_UNAVAILABLE'
[[ $(jq -r '.object.sha' "$temporary/main.json") == "$sha" ]] || fail 'MAIN_CHANGED'
current_permission=$(bash "$(dirname "$0")/check-release-permission.sh" "$token_file") || fail 'CD_RELEASE_PERMISSION_REJECTED'
[[ "$current_permission" == "$permission_version" ]] || fail 'CD_RELEASE_PERMISSION_CHANGED'
now=$(date -u +%s)
(( now >= created_epoch && now - created_epoch < 3600 )) || fail 'APPROVAL_OUTSIDE_ONE_HOUR'
# 失敗した配信も同じrun/attemptを自動再試行しない。発行し直して本人が承認する。
used="$state/used-$id-a$attempt"
if [[ -e "$used" || -L "$used" ]]; then printf 'APPROVAL_ALREADY_USED_SKIP\n'; exit 0; fi
mkdir -- "$used" || fail 'APPROVAL_CONSUMPTION_FAILED'
export SITEFLOW_CD_PERMISSION_VERSION="$permission_version"
export SITEFLOW_CD_APPROVAL_EXPIRES_EPOCH=$((created_epoch + 3600))
bash "$(dirname "$0")/release.sh" "$temporary/approved-release.json" "$settings" "$token_file"
