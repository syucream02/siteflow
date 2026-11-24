#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 1 && $1 =~ ^deploy-[1-9][0-9]{0,19}-1$ ]] || { printf 'INVALID_RELEASE_ID\n' >&2; exit 1; }
# Only an already installed fixed template is callable. No arbitrary commands,
# files, paths, images, DB operations, or parameter substitution are accepted.
result=0
/usr/bin/systemctl start --wait "siteflow-aws-release@$1.service" || result=$?
# Report a strict allowlist of metadata, not arbitrary journal/service output.
/usr/local/bin/node /usr/local/lib/siteflow/aws/report.mjs "$1" || result=1
exit "$result"
