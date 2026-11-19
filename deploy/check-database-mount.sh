#!/usr/bin/env bash
# DB専用EBSの照合のみ。Docker操作、mount、dir/data作成を行わない。
set -Eeuo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${SITEFLOW_MYSQL_DATA_MOUNT:-} == /srv/siteflow-mysql ]] || fail 'INVALID_DATA_MOUNT'
[[ ${SITEFLOW_MYSQL_EBS_VOLUME_ID:-} =~ ^vol-[a-f0-9]{17}$ ]] || fail 'EBS_VOLUME_ID_REQUIRED'
[[ ${SITEFLOW_MYSQL_FS_UUID:-} =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || fail 'FILESYSTEM_UUID_REQUIRED'
[[ $(readlink -f -- "$SITEFLOW_MYSQL_DATA_MOUNT") == "$SITEFLOW_MYSQL_DATA_MOUNT" ]] || fail 'DATA_MOUNT_PATH_MISMATCH'
mountpoint --quiet -- "$SITEFLOW_MYSQL_DATA_MOUNT" || fail 'DATA_EBS_NOT_MOUNTED'
source=$(findmnt --noheadings --raw --mountpoint "$SITEFLOW_MYSQL_DATA_MOUNT" --output SOURCE 2>/dev/null) || fail 'DATA_EBS_NOT_MOUNTED'
[[ "$source" =~ ^/dev/nvme[0-9]+n[0-9]+$ ]] || fail 'UNEXPECTED_DATA_DEVICE'
uuid=$(findmnt --noheadings --raw --mountpoint "$SITEFLOW_MYSQL_DATA_MOUNT" --output UUID 2>/dev/null) || fail 'DATA_UUID_UNAVAILABLE'
[[ "$uuid" == "$SITEFLOW_MYSQL_FS_UUID" ]] || fail 'DATA_UUID_MISMATCH'
fstype=$(findmnt --noheadings --raw --mountpoint "$SITEFLOW_MYSQL_DATA_MOUNT" --output FSTYPE 2>/dev/null) || fail 'DATA_FILESYSTEM_UNAVAILABLE'
[[ "$fstype" == xfs ]] || fail 'DATA_FILESYSTEM_MISMATCH'
serial=$(lsblk --nodeps --noheadings --output SERIAL "$source" 2>/dev/null) || fail 'DATA_EBS_UNIDENTIFIED'
serial=${serial//[[:space:]]/}
[[ "$serial" == "${SITEFLOW_MYSQL_EBS_VOLUME_ID//-/}" ]] || fail 'DATA_EBS_ID_MISMATCH'
printf 'DATA_EBS_MOUNT_VERIFIED\n'
