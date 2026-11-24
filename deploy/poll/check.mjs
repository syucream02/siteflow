import { createHash } from 'node:crypto';
import { assessRelease, exactFields, need } from './contract.mjs';
import { validateGithubResponses } from './github.mjs';

// 純粋な模擬統合判定。認証済みHTTP応答を受け渡す本番adapterではない。
// archiveBytesはZIPと想定した不透明な入力。構文・展開・JSONとの対応は未検証。
// SHA-256一致は渡されたバイト列と渡されたAPI値の一致であり、真正性ではない。
// image/migration情報も第1段階の別入力。job outputsやGHCRの実体を取得した証拠ではない。
export function checkCandidate(data, now) {
  exactFields(data, ['record', 'input', 'responses', 'policy', 'archiveBytes'], 'INVALID_CHECK_INPUT');
  const { record, input, responses, policy, archiveBytes } = data;
  const local = assessRelease(record, input, now);
  const github = validateGithubResponses(record, responses, policy, now);
  for (const key of ['repository', 'branch', 'mainSha', 'runId', 'attempt', 'artifactId',
    'artifactCreatedAt', 'permissionUpdatedAt', 'releaseEnabled']) {
    need(input[key] === github[key], 'LOCAL_GITHUB_INPUT_MISMATCH');
  }
  need(archiveBytes instanceof Uint8Array && archiveBytes.byteLength > 0 &&
    archiveBytes.byteLength <= 131072 && archiveBytes.byteLength === github.artifactZipBytes, 'INVALID_ARCHIVE_BYTES');
  const zipDigest = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`;
  need(zipDigest === github.artifactZipDigest, 'ARTIFACT_ZIP_DIGEST_MISMATCH');
  return {
    status: 'mock_candidate_consistency_passed', executionAllowed: false,
    releaseId: local.releaseId, expiresAt: local.expiresAt, artifactId: github.artifactId,
    artifactZipDigest: zipDigest, imageDigest: record.digest, migrationImageDigest: record.migrationDigest,
    pendingChecks: ['authenticated_response_origin_and_request_binding', 'reviewed_workflow_source',
      'complete_fresh_api_snapshot', 'safe_zip_extraction_and_json_binding', 'ghcr_image_contents',
      'durable_consumption_and_lock', 'trusted_authorization_handoff'],
  };
}
