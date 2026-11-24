import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateWorkflowPolicy } from '../deploy/poll/workflow-policy.mjs';
import { PINNED_PATHS } from '../deploy/poll/transport.mjs';
import fs from 'node:fs';
import { createReleaseRecord, releaseEnabled } from '../deploy/release-record.mjs';
const SHA = 'a'.repeat(40);
function fixture() {
  const files = {}, hashes = {};
  for (const path of PINNED_PATHS) {
    const bytes = Buffer.from(`FIXED TEST SOURCE: ${path}\n`);
    // フィクスチャの固定内容に対する期待値。本番取得値を自動採用する設計ではない。
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    files[path] = { ref: SHA, body: { type: 'file', path, encoding: 'base64', size: bytes.length,
      content: bytes.toString('base64'), sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') } };
  }
  return { workflow: { id: 22, path: '.github/workflows/ci.yml', state: 'active' }, files, policy: { workflowId: 22, hashes } };
}

// Node標準だけで読む限定的な構造/契約検査。YAML/Actions構文全体の検証ではない。
const ciSource = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
// Official release -> commit links and action.yml reviewed anonymously. Not a live API check.
// https://github.com/{owner}/{action}/releases/tag/{version}
const reviewedActions = Object.freeze({
  'actions/checkout': { sha: '11bd71901bbe5b1630ceea73d27597364c9af683', version: 'v4.2.2' },
  'actions/setup-node': { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', version: 'v4.4.0' },
  'docker/login-action': { sha: '5e57cd118135c172c3672efd75eb46360885c0ef', version: 'v3.6.0' },
  'actions/upload-artifact': { sha: 'ea165f8d65b6e75b540449e92b4886f43607fa02', version: 'v4.6.2' },
});
function reviewedAction(value) {
  const m = /^([\w.-]+\/[\w.-]+)@([a-f0-9]{40})(?:[ \t]+#[ \t]+(v[0-9]+\.[0-9]+\.[0-9]+))?$/.exec(value);
  assert.ok(m, 'Action must use an exact 40-character SHA with an optional version comment');
  assert.ok(Object.hasOwn(reviewedActions, m[1]), 'Unreviewed Action');
  assert.notEqual(m[2], '0'.repeat(40), 'Zero SHA is forbidden');
  assert.equal(m[2], reviewedActions[m[1]].sha, 'Unreviewed Action SHA');
  if (m[3]) assert.equal(m[3], reviewedActions[m[1]].version, 'Version comment mismatch');
  return m[1];
}
function pollingWorkflowContract(text) {
  const jobs = text.split('\njobs:\n');
  assert.equal(jobs.length, 2);
  assert.deepEqual([...jobs[1].matchAll(/^  ([\w-]+):$/gm)].map(m => m[1]), ['docker-build', 'release-approved']);
  const [build, release] = jobs[1].split('\n  release-approved:\n');
  assert.ok(release);
  assert.match(text, /concurrency:\n  group: siteflow-ci-\$\{\{ github.ref \}\}\n  cancel-in-progress: true\n/);
  assert.match(build, /outputs:\n      digest: \$\{\{ steps.publish.outputs.digest \}\}\n      migration_digest: \$\{\{ steps.publish.outputs.migration_digest \}\}/);
  assert.match(release, /^    needs: docker-build\n/);
  assert.match(release, /if: github.repository == 'syucream02\/siteflow' && github.event_name == 'push' && github.ref == 'refs\/heads\/main' && github.run_attempt == 1\n/);
  assert.match(release, /    environment: production\n    permissions:\n      contents: read\n    steps:/);
  assert.match(release, /ref: \$\{\{ github.sha \}\}\n          persist-credentials: false/);
  assert.match(release, /id: release-switch\n        env:\n          SITEFLOW_RELEASE_ENABLED: \$\{\{ vars.SITEFLOW_RELEASE_ENABLED \}\}\n        run: node deploy\/release-record.mjs --check-gate/);
  assert.equal((release.match(/if: steps.release-switch.outputs.enabled == 'true'/g) ?? []).length, 2);
  assert.match(release, /name: Record approved immutable images\n        if: steps.release-switch.outputs.enabled == 'true'\n        env:\n          SITEFLOW_RELEASE_ENABLED: \$\{\{ vars.SITEFLOW_RELEASE_ENABLED \}\}\n          SITEFLOW_IMAGE_DIGEST: \$\{\{ needs.docker-build.outputs.digest \}\}\n          SITEFLOW_MIGRATION_DIGEST: \$\{\{ needs.docker-build.outputs.migration_digest \}\}\n        run: node deploy\/release-record.mjs\n/);
  assert.match(release, /- uses: actions\/upload-artifact@[a-f0-9]{40}(?:[ \t]+#[ \t]+v[0-9]+\.[0-9]+\.[0-9]+)?\n        if: steps.release-switch.outputs.enabled == 'true'\n        with:\n          name: approved-release-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}\n          path: approved-release.json\n          if-no-files-found: error\n          retention-days: 30/);
  assert.equal((release.match(/^      - /gm) ?? []).length, 5);
  assert.deepEqual([...release.matchAll(/^        run: (.+)$/gm)].map(m => m[1]), ['node deploy/release-record.mjs --check-gate', 'node deploy/release-record.mjs']);
  assert.deepEqual([...release.matchAll(/^      - uses: (.+)$/gm)].map(m => reviewedAction(m[1])), ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']);
  assert.doesNotMatch(release, /continue-on-error:|always\(\)|\boverwrite:|docker\s|\bssh\b|\bscp\b|aws-actions\/|\baws\s|id-token:|packages:|deploy\/aws|deploy\/migrate|prisma\s/);
  assert.doesNotMatch(text, /name: ci-images-|deploy\/aws\/ci-record.mjs/);
  const uses = [...text.matchAll(/^[ \t]*-?[ \t]*uses: (.+)$/gm)];
  assert.equal(uses.length, 6);
  for (const use of uses) reviewedAction(use[1]);
  return { executionAllowed: false, contract: 'static_local_consistency_only' };
}

test('M3: 実ci.ymlのproducerは同run2job/production/厳密gate/needs digest契約と一致', () => {
  assert.equal(pollingWorkflowContract(ciSource).executionAllowed, false);
});
for (const [name, mutate] of [
  ['承認jobなし', s => s.slice(0, s.indexOf('\n  release-approved:'))],
  ['第三job', s => s + '\n  unsafe-extra:\n    runs-on: ubuntu-latest\n'],
  ['needsなし', s => s.replace('    needs: docker-build\n', '')],
  ['productionなし', s => s.replace('    environment: production\n', '')],
  ['PRでも承認', s => s.replace("github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_attempt == 1", "github.event_name == 'pull_request'")],
  ['attempt制限なし', s => s.replace(' && github.run_attempt == 1', '')],
  ['別repo', s => s.replace("github.repository == 'syucream02/siteflow'", "github.repository == 'other/repo'")],
  ['可変checkout', s => s.replace('ref: ${{ github.sha }}', 'ref: main')],
  ['falseでも生成', s => s.replaceAll("if: steps.release-switch.outputs.enabled == 'true'", 'if: always()')],
  ['digestタグ再解決', s => s.replace('SITEFLOW_IMAGE_DIGEST: ${{ needs.docker-build.outputs.digest }}', 'SITEFLOW_IMAGE_DIGEST: latest')],
  ['migration digest欠損', s => s.replace('SITEFLOW_MIGRATION_DIGEST: ${{ needs.docker-build.outputs.migration_digest }}', 'SITEFLOW_MIGRATION_DIGEST: null')],
  ['artifact名差替え', s => s.replace('name: approved-release-', 'name: ci-images-')],
  ['artifact上書き', s => s.replace('          path: approved-release.json', '          overwrite: true\n          path: approved-release.json')],
  ['承認後build', s => s + '\n      - run: docker build .\n'],
  ['SSH配信', s => s + '\n      - run: ssh example.invalid\n'],
  ['migration実行', s => s + '\n      - run: node deploy/migrate.mjs\n'],
  ['AWS配信', s => s + '\n      - run: node deploy/aws/publish.mjs\n'],
  ['OIDC権限', s => s.replace('    environment: production', '    permissions:\n      id-token: write\n    environment: production')],
  ['concurrency変更', s => s.replace('cancel-in-progress: true', 'cancel-in-progress: false')],
  ['可変Action tag', s => s.replace('docker/login-action@' + reviewedActions['docker/login-action'].sha, 'docker/login-action@v3')],
  ['全0 Action SHA', s => s.replace(reviewedActions['docker/login-action'].sha, '0'.repeat(40))],
  ['短いAction SHA', s => s.replace(reviewedActions['docker/login-action'].sha, reviewedActions['docker/login-action'].sha.slice(0, 7))],
  ['未レビューAction SHA', s => s.replace(reviewedActions['docker/login-action'].sha, 'a'.repeat(40))],
  ['SHAの末尾に余分な文字', s => s.replace(reviewedActions['docker/login-action'].sha, reviewedActions['docker/login-action'].sha + 'a')],
  ['バージョンコメント不一致', s => s.replace('# v3.6.0', '# v4.0.0')],
  ['未知の追加コマンド', s => s + '\n      - run: curl --request POST https://example.invalid\n'],
  ['未知の追加Action', s => s + '\n      - uses: unknown/deploy@' + 'a'.repeat(40) + '\n'],
]) test(`M3: 実workflow契約の変異を拒否: ${name}`, () => assert.throws(() => pollingWorkflowContract(mutate(ciSource))));

const releaseEnv = { SITEFLOW_RELEASE_ENABLED: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'syucream02/siteflow',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1', SITEFLOW_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  SITEFLOW_MIGRATION_DIGEST: `sha256:${'c'.repeat(64)}`, SITEFLOW_SCHEMA_HASH: 'd'.repeat(64) };
test('M3: gate trueと既存JSON形式はapp/migrationのOCI digestを別々に保持する', () => {
  assert.equal(releaseEnabled('true'), true);
  const r = createReleaseRecord(releaseEnv); assert.equal(r.digest, releaseEnv.SITEFLOW_IMAGE_DIGEST); assert.equal(r.migrationDigest, releaseEnv.SITEFLOW_MIGRATION_DIGEST);
  assert.equal(r.sha, releaseEnv.GITHUB_SHA); assert.equal(r.runId, '101'); assert.equal(r.attempt, '1');
});
for (const value of ['false', undefined, '', 'TRUE', ' true', 'true ', '1', true, null]) test(`M3: true以外はJSON/artifact生成gateを開かない: ${String(value)}`, () => {
  assert.throws(() => createReleaseRecord({ ...releaseEnv, SITEFLOW_RELEASE_ENABLED: value }));
  if (['false', undefined, ''].includes(value)) assert.equal(releaseEnabled(value), false);
  else assert.throws(() => releaseEnabled(value));
});
test('M3: 全Actionはレビュー済み非zero SHAと対応バージョンに固定する', () => {
  assert.doesNotMatch(ciSource, /@0{40}(?:\s|$)/m);
  assert.equal(Object.hasOwn(pollingWorkflowContract(ciSource), 'authorized'), false);
});
test('M3: バージョンコメントの有無はSHA検査と承認契約を変えない', () => {
  assert.equal(pollingWorkflowContract(ciSource.replace(/ # v[0-9]+\.[0-9]+\.[0-9]+/g, '')).executionAllowed, false);
});
test('固定コードを照合しても実行許可を返さない', () => {
  const f = fixture(), before = structuredClone(f);
  assert.equal(validateWorkflowPolicy(f.workflow, SHA, f.files, f.policy).executionAllowed, false);
  assert.deepEqual(f, before);
});
for (const path of PINNED_PATHS) {
  test(`固定ハッシュ不一致を拒否: ${path}`, () => {
    const f = fixture(); f.policy.hashes[path] = 'b'.repeat(64);
    assert.throws(() => validateWorkflowPolicy(f.workflow, SHA, f.files, f.policy), /WORKFLOW_HASH_MISMATCH/);
  });
}
for (const [name, mutate] of [
  ['workflow ID', f => { f.workflow.id = 23; }], ['workflow path', f => { f.workflow.path = 'other'; }],
  ['ref不一致', f => { f.files['Dockerfile'].ref = 'f'.repeat(40); }],
  ['固定値未設定', f => { f.policy.hashes.Dockerfile = '0'.repeat(64); }],
  ['固定値欠落', f => { delete f.policy.hashes.Dockerfile; }],
  ['未知の固定項目', f => { f.policy.hashes.extra = 'f'.repeat(64); }],
  ['取得コード欠落', f => { delete f.files.Dockerfile; }],
  ['不正Base64', f => { f.files.Dockerfile.body.content = '%%%'; }],
  ['blob SHA不一致', f => { f.files.Dockerfile.body.sha = 'f'.repeat(40); }],
  ['サイズ不一致', f => { f.files.Dockerfile.body.size = 1; }],
  ['symlink応答', f => { f.files.Dockerfile.body.type = 'symlink'; }],
]) {
  test(`コード固定の異常を拒否: ${name}`, () => {
    const f = fixture(); mutate(f); assert.throws(() => validateWorkflowPolicy(f.workflow, SHA, f.files, f.policy));
  });
}
