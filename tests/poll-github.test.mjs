import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateGithubResponses, githubTime } from '../deploy/poll/github.mjs';
import { checkCandidate } from '../deploy/poll/check.mjs';
import { createState, transitionState } from '../deploy/poll/state.mjs';

// 模擬データのみ。実アカウントID・認証情報・通信処理は使わない。
const BASE = 1700000000, NOW = BASE + 100;
const SHA = 'a'.repeat(40), DIGEST = `sha256:${'b'.repeat(64)}`;
const MIGRATION = `sha256:${'c'.repeat(64)}`, SCHEMA = 'd'.repeat(64);
const REPO = 'syucream02/siteflow', IMAGE = `ghcr.io/${REPO}`;
const API = `https://api.github.com/repos/${REPO}`;
const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const archive = () => Buffer.from('MOCK OPAQUE ARCHIVE BYTES; ZIP STRUCTURE IS NOT TESTED');
const archiveHash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function fixture() {
  const record = { schemaVersion: 1, repository: REPO, workflow: '.github/workflows/ci.yml',
    sha: SHA, runId: '101', attempt: '1', imageRepository: IMAGE,
    digest: DIGEST, migrationDigest: MIGRATION, schemaHash: SCHEMA, approved: true };
  const input = { repository: REPO, branch: 'main', mainSha: SHA, runId: '101', attempt: '1',
    artifactId: '202', artifactCreatedAt: BASE + 50, permissionUpdatedAt: BASE + 10,
    expiresAt: BASE + 350, releaseEnabled: 'true', consumedIds: [],
    image: { repository: IMAGE, digest: DIGEST, revision: SHA },
    migration: { repository: IMAGE, digest: MIGRATION, revision: SHA },
    schemaHash: SCHEMA, migrationRequired: false };
  const repository = { id: 11, full_name: REPO };
  const job = (name, id, start, end) => ({ id, name, run_id: 101,
    run_url: `${API}/actions/runs/101`, head_sha: SHA, head_branch: 'main',
    status: 'completed', conclusion: 'success', started_at: iso(BASE + start), completed_at: iso(BASE + end) });
  const bytes = archive();
  const responses = {
    repository,
    workflow: { id: 22, path: '.github/workflows/ci.yml', state: 'active' },
    run: { id: 101, run_attempt: 1, workflow_id: 22, path: '.github/workflows/ci.yml',
      url: `${API}/actions/runs/101`, repository: { ...repository }, head_repository: { ...repository },
      event: 'push', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success',
      created_at: iso(BASE), updated_at: iso(BASE + 80) },
    jobs: { total_count: 2, jobs: [job('docker-build', 1001, 1, 20), job('release-approved', 1002, 30, 60)] },
    approvals: [{ state: 'approved', comment: 'Mock review', user: { id: 44, login: 'syucream02', type: 'User' },
      environments: [{ id: 33, name: 'production' }] }],
    environment: { id: 33, name: 'production' },
    mainRef: { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } },
    variable: { name: 'SITEFLOW_RELEASE_ENABLED', value: 'true', created_at: iso(BASE), updated_at: iso(BASE + 10) },
    artifacts: { total_count: 1, artifacts: [{ id: 202,
      name: `approved-release-${SHA}-101-1`, expired: false,
      url: `${API}/actions/artifacts/202`, archive_download_url: `${API}/actions/artifacts/202/zip`,
      digest: archiveHash(bytes), size_in_bytes: bytes.byteLength,
      created_at: iso(BASE + 50), expires_at: iso(BASE + 86400),
      workflow_run: { id: 101, repository_id: 11, head_repository_id: 11, head_branch: 'main', head_sha: SHA } }] },
  };
  return { record, input, responses, policy: { repositoryId: 11, workflowId: 22, environmentId: 33, approverId: 44 },
    archiveBytes: bytes };
}

test('正常な模擬応答の整合性に合格しても実行許可・authorizedを発行しない', () => {
  const data = fixture(), before = structuredClone(data);
  const result = checkCandidate(data, NOW);
  assert.equal(result.status, 'mock_candidate_consistency_passed');
  assert.equal(result.executionAllowed, false);
  assert.equal(result.releaseId, 'used-101-a1');
  assert.equal(Object.hasOwn(result, 'token'), false);
  assert.equal(Object.hasOwn(result, 'authorized'), false);
  assert.ok(result.pendingChecks.includes('authenticated_response_origin_and_request_binding'));
  assert.ok(result.pendingChecks.includes('safe_zip_extraction_and_json_binding'));
  assert.deepEqual(structuredClone(data), before);
});
test('API検査単体も模擬結果であり、jobとの対応を直接証明とは表現しない', () => {
  const { record, responses, policy } = fixture();
  const result = validateGithubResponses(record, responses, policy, NOW);
  assert.equal(result.executionAllowed, false);
  assert.equal(result.approvalBinding, 'same_run_environment_and_reviewed_workflow_assumption');
  assert.equal(result.artifactZipDigest, responses.artifacts.artifacts[0].digest);
});

const cases = [
  ['異なるrepo名', d => { d.responses.repository.full_name = 'other/repo'; }],
  ['異なるrepo ID', d => { d.responses.repository.id = 12; }],
  ['fork由来run', d => { d.responses.run.head_repository.full_name = 'other/siteflow'; }],
  ['異なるブランチ', d => { d.responses.run.head_branch = 'feature'; }],
  ['PRイベント', d => { d.responses.run.event = 'pull_request'; }],
  ['最新main SHA不一致', d => { d.responses.mainRef.object.sha = 'f'.repeat(40); }],
  ['main以外のref', d => { d.responses.mainRef.ref = 'refs/heads/feature'; }],
  ['commit以外のref', d => { d.responses.mainRef.object.type = 'tag'; }],
  ['CI失敗', d => { d.responses.run.conclusion = 'failure'; }],
  ['CI未完了', d => { d.responses.run.status = 'in_progress'; d.responses.run.conclusion = null; }],
  ['runキャンセル', d => { d.responses.run.conclusion = 'cancelled'; }],
  ['run ID不一致', d => { d.responses.run.id = 102; }],
  ['数値でないrun ID', d => { d.responses.run.id = '101'; }],
  ['不正確な巨大run ID', d => { d.responses.run.id = Number.MAX_SAFE_INTEGER + 1; }],
  ['run attempt不一致', d => { d.responses.run.run_attempt = 2; }],
  ['記録attempt不一致', d => { d.record.attempt = '2'; }],
  ['workflow ID不一致', d => { d.responses.run.workflow_id = 23; }],
  ['workflow path不一致', d => { d.responses.workflow.path = '.github/workflows/other.yml'; }],
  ['run path不一致', d => { d.responses.run.path = '.github/workflows/other.yml'; }],
  ['無効workflow', d => { d.responses.workflow.state = 'disabled_manually'; }],
  ['run取得先不一致', d => { d.responses.run.url = 'https://example.invalid/run'; }],
  ['production承認欠落', d => { d.responses.approvals = []; }],
  ['承認者名不一致', d => { d.responses.approvals[0].user.login = 'someone'; }],
  ['承認者ID不一致', d => { d.responses.approvals[0].user.id = 45; }],
  ['Bot承認者', d => { d.responses.approvals[0].user.type = 'Bot'; }],
  ['拒否履歴', d => { d.responses.approvals[0].state = 'rejected'; }],
  ['承認job保留中', d => { d.responses.jobs.jobs[1].status = 'waiting'; d.responses.jobs.jobs[1].conclusion = null; }],
  ['矛盾する複数承認', d => { d.responses.approvals.push({ ...d.responses.approvals[0], state: 'rejected' }); }],
  ['曖昧な重複承認', d => { d.responses.approvals.push(structuredClone(d.responses.approvals[0])); }],
  ['別environment', d => { d.responses.approvals[0].environments[0].name = 'staging'; }],
  ['environment ID不一致', d => { d.responses.approvals[0].environments[0].id = 34; }],
  ['複数environment承認', d => { d.responses.approvals[0].environments.push({ id: 34, name: 'staging' }); }],
  ['environment応答不一致', d => { d.responses.environment.id = 34; }],
  ['jobのrun不一致', d => { d.responses.jobs.jobs[1].run_id = 102; }],
  ['jobの取得先不一致', d => { d.responses.jobs.jobs[1].run_url = 'https://example.invalid/run'; }],
  ['jobのSHA不一致', d => { d.responses.jobs.jobs[1].head_sha = 'f'.repeat(40); }],
  ['jobのbranch不一致', d => { d.responses.jobs.jobs[0].head_branch = 'other'; }],
  ['build job失敗', d => { d.responses.jobs.jobs[0].conclusion = 'failure'; }],
  ['承認job欠落', d => { d.responses.jobs.jobs[1].name = 'other'; }],
  ['job重複ID', d => { d.responses.jobs.jobs[1].id = 1001; }],
  ['jobページ不足', d => { d.responses.jobs.total_count = 3; }],
  ['job構成変更', d => { d.responses.jobs.jobs.push({ ...d.responses.jobs.jobs[0], id: 1003 }); d.responses.jobs.total_count = 3; }],
  ['CIより前に承認job開始', d => { d.responses.jobs.jobs[1].started_at = iso(BASE + 19); }],
  ['artifact ID不一致', d => { d.input.artifactId = '203'; }],
  ['artifact名不一致', d => { d.responses.artifacts.artifacts[0].name = 'other'; }],
  ['artifact別run', d => { d.responses.artifacts.artifacts[0].workflow_run.id = 102; }],
  ['artifact別repo', d => { d.responses.artifacts.artifacts[0].workflow_run.repository_id = 12; }],
  ['artifact別head repo', d => { d.responses.artifacts.artifacts[0].workflow_run.head_repository_id = 12; }],
  ['artifact別SHA', d => { d.responses.artifacts.artifacts[0].workflow_run.head_sha = 'f'.repeat(40); }],
  ['artifact別branch', d => { d.responses.artifacts.artifacts[0].workflow_run.head_branch = 'other'; }],
  ['artifactメタデータ欠落', d => { delete d.responses.artifacts.artifacts[0].digest; }],
  ['artifact保存期限切れ', d => { d.responses.artifacts.artifacts[0].expires_at = iso(NOW); }],
  ['artifact失効フラグ', d => { d.responses.artifacts.artifacts[0].expired = true; }],
  ['artifact重複名', d => { d.responses.artifacts.artifacts.push({ ...d.responses.artifacts.artifacts[0], id: 203 }); d.responses.artifacts.total_count = 2; }],
  ['artifact不完全ページ', d => { d.responses.artifacts.total_count = 2; }],
  ['artifact取得先不一致', d => { d.responses.artifacts.artifacts[0].archive_download_url = 'https://example.invalid/zip'; }],
  ['ZIP digest不一致', d => { d.responses.artifacts.artifacts[0].digest = `sha256:${'e'.repeat(64)}`; }],
  ['ZIPとOCIの混同を拒否', d => { d.responses.artifacts.artifacts[0].digest = DIGEST; }],
  ['ZIPバイト列の改変', d => { d.archiveBytes = Buffer.alloc(d.archiveBytes.length, 1); }],
  ['ZIP長さ不一致', d => { d.archiveBytes = Buffer.from('different length'); }],
  ['ZIP上限超過', d => { d.archiveBytes = Buffer.alloc(131073); }],
  ['ZIP不正型', d => { d.archiveBytes = 'bytes'; }],
  ['アプリdigest不一致', d => { d.input.image.digest = MIGRATION; }],
  ['migration digest不一致', d => { d.input.migration.digest = DIGEST; }],
  ['OCI revision不一致', d => { d.input.image.revision = 'f'.repeat(40); }],
  ['配信禁止', d => { d.responses.variable.value = 'false'; }],
  ['変数のboolean許可', d => { d.responses.variable.value = true; }],
  ['別の変数', d => { d.responses.variable.name = 'OTHER'; }],
  ['古い入力の許可情報', d => { d.input.permissionUpdatedAt = BASE + 9; }],
  ['承認より後の変数変更', d => { d.responses.variable.updated_at = iso(BASE + 51); }],
  ['配信期限切れ', d => { d.input.expiresAt = NOW; }],
  ['消費済み配信', d => { d.input.consumedIds = ['used-101-a1']; }],
  ['schema不一致', d => { d.input.schemaHash = 'f'.repeat(64); }],
  ['migration必要', d => { d.input.migrationRequired = true; }],
  ['不正な時刻型', d => { d.responses.run.created_at = BASE; }],
  ['不正な時刻文字列', d => { d.responses.variable.updated_at = '2023-02-30T00:00:00Z'; }],
  ['未来のrun更新時刻', d => { d.responses.run.updated_at = iso(NOW + 1); }],
  ['job完了より古いrun更新時刻', d => { d.responses.run.updated_at = iso(BASE + 59); }],
  ['承認jobの範囲外でartifact生成', d => { d.responses.artifacts.artifacts[0].created_at = iso(BASE + 29); }],
  ['policyの自由なverifiedフラグ', d => { d.policy.verified = true; }],
  ['応答envelopeの自由な承認文字列', d => { d.responses.verified = 'approved'; }],
];
for (const [name, edit] of cases) {
  test(`模擬異常を拒否: ${name}`, () => {
    const data = fixture(); edit(data);
    assert.throws(() => checkCandidate(data, NOW));
  });
}

for (const key of Object.keys(fixture().responses)) {
  test(`API情報欠落を拒否: ${key}`, () => {
    const data = fixture(); delete data.responses[key];
    assert.throws(() => checkCandidate(data, NOW), /INVALID_GITHUB_RESPONSE_SET/);
  });
  test(`API応答の不正型を拒否: ${key}`, () => {
    const data = fixture(); data.responses[key] = null;
    assert.throws(() => checkCandidate(data, NOW));
  });
}
test('attemptを両方2へ揃えても再実行を拒否する', () => {
  const data = fixture(); data.record.attempt = '2'; data.input.attempt = '2'; data.responses.run.run_attempt = 2;
  assert.throws(() => checkCandidate(data, NOW), /RERUN_NOT_SUPPORTED/);
});
test('大きなID・prototype・getter・未知のローカル入力を拒否', () => {
  const data = fixture(); data.policy.workflowId = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => checkCandidate(data, NOW), /INVALID_POLICY_OR_TIME/);
  const next = fixture(); let called = false;
  Object.defineProperty(next.responses.run, 'head_sha', { enumerable: true, get() { called = true; return SHA; } });
  assert.throws(() => checkCandidate(next, NOW)); assert.equal(called, false);
  assert.throws(() => checkCandidate({ ...fixture(), authorized: true }, NOW), /INVALID_CHECK_INPUT/);
  const bad = fixture(); bad.responses.workflow = Object.assign(Object.create({}), bad.responses.workflow);
  assert.throws(() => checkCandidate(bad, NOW));
});
test('ZIP保持期限と配信期限は独立で、OCI digestとも比較しない', () => {
  const data = fixture(); const result = checkCandidate(data, NOW);
  assert.equal(result.artifactZipDigest, archiveHash(data.archiveBytes));
  assert.equal(result.imageDigest, DIGEST); assert.equal(result.migrationImageDigest, MIGRATION);
  assert.notEqual(result.artifactZipDigest, result.imageDigest);
  assert.equal(result.expiresAt, BASE + 350);
});
test('正常な追加API項目は安全判定に利用せず、依然として実行不可', () => {
  const data = fixture(); data.responses.run.html_url = `https://github.com/${REPO}/actions/runs/101`;
  data.responses.workflow.name = 'Docker Build and Smoke Test';
  assert.equal(checkCandidate(data, NOW).executionAllowed, false);
});
test('作り物の応答とバイト列をすべて揃えても第1段階のauthorized境界を越えない', () => {
  const data = fixture();
  data.archiveBytes = Buffer.from('ATTACKER CAN FABRICATE EVERY MOCK INPUT');
  data.responses.artifacts.artifacts[0].size_in_bytes = data.archiveBytes.length;
  data.responses.artifacts.artifacts[0].digest = archiveHash(data.archiveBytes);
  const result = checkCandidate(data, NOW);
  assert.equal(result.executionAllowed, false);
  const state = createState({ kind: 'nextjs', container: 'siteflow-test-current', port: 3001,
    image: `sha256:${'e'.repeat(64)}` }, BASE);
  assert.throws(() => transitionState(state, { type: 'authorize', result, verified: true }, NOW), /EXTERNAL_VERIFICATION_NOT_IMPLEMENTED/);
});
test('取消に架空フィールドを使わず、run・変数・履歴・期限の実項目を検査', () => {
  for (const edit of [d => { d.responses.run.status = 'waiting'; },
    d => { d.responses.run.conclusion = 'cancelled'; },
    d => { d.responses.variable.value = 'false'; },
    d => { d.responses.approvals[0].state = 'rejected'; },
    d => { d.input.expiresAt = NOW; }]) {
    const data = fixture(); edit(data); assert.throws(() => checkCandidate(data, NOW));
  }
});
test('GitHub時刻はUTCの実在する日付のみ受け付ける', () => {
  assert.equal(githubTime(iso(BASE)), BASE);
  assert.equal(githubTime(new Date(BASE * 1000 + 123).toISOString()), BASE + 0.123);
  for (const value of [null, '2023-02-30T00:00:00Z', '2023-11-14', '2023-11-14T00:00:00+00:00']) {
    assert.throws(() => githubTime(value), /INVALID_GITHUB_TIME/);
  }
});
test('検証モジュールはHTTP・環境変数・ファイル・プロセス操作を含まない', () => {
  for (const file of ['../deploy/poll/github.mjs', '../deploy/poll/check.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:(fs|http|https|net|child_process)|process\.|fetch\s*\(/);
  }
});
