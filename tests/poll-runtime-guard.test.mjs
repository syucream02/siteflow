import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { assessRuntimeGuard } from '../deploy/poll/runtime-guard.mjs';
import { pathChain } from '../deploy/poll/linux-storage.mjs';
import { PINNED_PATHS } from '../deploy/poll/transport.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStateStore } from '../deploy/poll/persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock } from '../deploy/poll/lock.mjs';
import { advanceNginxPlan } from '../deploy/poll/nginx-plan.mjs';

// 架空のAPI、架空のレビュー済みハッシュとLinux観測。真正性を証明しない。
const BASE = 1700000000, NOW = BASE + 100, SHA = 'a'.repeat(40), DIGEST = `sha256:${'b'.repeat(64)}`, SCHEMA = 'd'.repeat(64);
const IMAGE = 'ghcr.io/syucream02/siteflow', API = 'https://api.github.com/repos/syucream02/siteflow';
const hash = x => createHash('sha256').update(x).digest('hex');
const iso = s => new Date(s * 1000).toISOString();
function zip(record) {
  // 試験用stored ZIP生成のみ。ZIP読取りは既存yauzl実装へ委譲。
  const name = Buffer.from('approved-release.json'), bytes = Buffer.from(JSON.stringify(record));
  const l = Buffer.alloc(30), c = Buffer.alloc(46), end = Buffer.alloc(22);
  l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc32(bytes), 14); l.writeUInt32LE(bytes.length, 18); l.writeUInt32LE(bytes.length, 22); l.writeUInt16LE(name.length, 26);
  c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc32(bytes), 16); c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(0x81a40000, 38);
  const directory = Buffer.concat([c, name]), local = Buffer.concat([l, name, bytes]);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, end]);
}
function fixture() {
  const record = { schemaVersion: 1, repository: 'syucream02/siteflow', workflow: '.github/workflows/ci.yml', sha: SHA, runId: '101', attempt: '1', imageRepository: IMAGE,
    digest: DIGEST, migrationDigest: `sha256:${'c'.repeat(64)}`, schemaHash: SCHEMA, approved: true };
  const archiveBytes = zip(record), repository = { id: 11, full_name: record.repository };
  const job = (name, id, start, end) => ({ id, name, run_id: 101, run_url: `${API}/actions/runs/101`, head_sha: SHA, head_branch: 'main', status: 'completed', conclusion: 'success', started_at: iso(BASE + start), completed_at: iso(BASE + end) });
  const responses = { repository, workflow: { id: 22, path: record.workflow, state: 'active' },
    run: { id: 101, run_attempt: 1, workflow_id: 22, path: record.workflow, url: `${API}/actions/runs/101`, repository: { ...repository }, head_repository: { ...repository },
      event: 'push', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success', created_at: iso(BASE), updated_at: iso(BASE + 80) },
    jobs: { total_count: 2, jobs: [job('docker-build', 1001, 1, 20), job('release-approved', 1002, 30, 60)] },
    approvals: [{ state: 'approved', comment: 'Mock', user: { id: 44, login: 'syucream02', type: 'User' }, environments: [{ id: 33, name: 'production' }] }],
    environment: { id: 33, name: 'production' }, mainRef: { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } },
    variable: { name: 'SITEFLOW_RELEASE_ENABLED', value: 'true', created_at: iso(BASE), updated_at: iso(BASE + 10) },
    artifacts: { total_count: 1, artifacts: [{ id: 202, name: `approved-release-${SHA}-101-1`, expired: false,
      url: `${API}/actions/artifacts/202`, archive_download_url: `${API}/actions/artifacts/202/zip`, digest: `sha256:${hash(archiveBytes)}`, size_in_bytes: archiveBytes.length,
      created_at: iso(BASE + 50), expires_at: iso(BASE + 86400), workflow_run: { id: 101, repository_id: 11, head_repository_id: 11, head_branch: 'main', head_sha: SHA } }] } };
  const input = { repository: record.repository, branch: 'main', mainSha: SHA, runId: '101', attempt: '1', artifactId: '202', artifactCreatedAt: BASE + 50,
    permissionUpdatedAt: BASE + 10, expiresAt: BASE + 350, releaseEnabled: 'true', consumedIds: [], image: { repository: IMAGE, digest: DIGEST, revision: SHA },
    migration: { repository: IMAGE, digest: record.migrationDigest, revision: SHA }, schemaHash: SCHEMA, migrationRequired: false };
  const files = {}, hashes = {};
  for (const p of PINNED_PATHS) {
    const bytes = Buffer.from(`MOCK REVIEWED CONTENT ${p}`); hashes[p] = hash(bytes);
    files[p] = { ref: SHA, body: { type: 'file', path: p, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length,
      sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') } };
  }
  const policy = { mount: '/srv/siteflow-mysql', uuid: '11111111-2222-3333-4444-555555555555', volumeId: 'vol-11111111111111111', stateDirectory: '/srv/siteflow-mysql/poll-state', mysqlDataDirectory: '/srv/siteflow-mysql/data', minFreeBytes: 256 * 1024 * 1024 };
  const stable = { kind: 'nextjs', container: 'current', port: 3001, image: `sha256:${'e'.repeat(64)}` };
  const state = { schemaVersion: 1, mode: 'local-model', executionAllowed: false, workspaceId: 'f'.repeat(64), revision: 0, updatedAt: BASE, phase: 'idle',
    stable, lastKnownGood: stable, previous: null, candidate: null, activeReleaseId: null, consumedIds: [], incident: null };
  return { stage: 'before_consume', githubData: { record, input, responses, policy: { repositoryId: 11, workflowId: 22, environmentId: 33, approverId: 44 }, archiveBytes },
    workflow: { files, policy: { workflowId: 22, hashes } }, state,
    storage: { policy, observation: { querySucceeded: true,
      mount: { target: policy.mount, realPath: policy.mount, source: '/dev/nvme1n1', uuid: policy.uuid, volumeId: policy.volumeId, fstype: 'xfs', options: ['rw'], deviceId: 2, mounted: true, encrypted: true },
      entries: pathChain(policy.stateDirectory).map(p => ({ path: p, realPath: p, type: 'directory', uid: 0, gid: 0, mode: p === policy.stateDirectory ? 0o700 : 0o755, symlink: false, deviceId: p.startsWith(policy.mount) ? 2 : 1 })),
      mysqlDataRealPath: policy.mysqlDataDirectory, freeBytes: 1024 ** 3, freeInodes: 1000, writeProbeSucceeded: true } },
    host: { observedAt: NOW, permissionValue: 'true', mainSha: SHA, paused: false, incident: false, residualLock: false,
      lock: { held: true, releaseId: 'used-101-a1', workspaceId: state.workspaceId, revision: 0 }, dockerHealthy: true, nginxHealthy: true, mysqlHealthy: true,
      rollback: { slot: stable, running: true, ready: true, configHash: 'f'.repeat(64) },
      image: { repository: IMAGE, digest: DIGEST, revision: SHA, schemaHash: SCHEMA, schemaSourceDigest: DIGEST } } };
}
test('guard: coherent fake inputs never authorize real execution', async () => {
  const d = fixture(), before = structuredClone(d), r = await assessRuntimeGuard(d, NOW);
  assert.equal(r.status, 'mock_runtime_consistent'); assert.equal(r.executionAllowed, false);
  assert.equal(Object.hasOwn(r, 'authorized'), false); assert.equal(Object.hasOwn(r, 'token'), false);
  assert.deepEqual(structuredClone(d), before);
});
const cases = [
  ['permission false', d => { d.host.permissionValue = 'false'; }], ['missing permission', d => { delete d.host.permissionValue; }],
  ['main changed', d => { d.host.mainSha = 'f'.repeat(40); }], ['CI failed', d => { d.githubData.responses.run.conclusion = 'failure'; }],
  ['no approval', d => { d.githubData.responses.approvals = []; }], ['wrong approver', d => { d.githubData.responses.approvals[0].user.id = 45; }],
  ['workflow hash differs', d => { d.workflow.policy.hashes.Dockerfile = 'f'.repeat(64); }],
  ['ZIP altered', d => { d.githubData.archiveBytes[40] ^= 1; }], ['OCI digest differs', d => { d.host.image.digest = `sha256:${'f'.repeat(64)}`; }],
  ['revision differs', d => { d.host.image.revision = 'f'.repeat(40); }], ['schema differs', d => { d.host.image.schemaHash = 'f'.repeat(64); }],
  ['migration required', d => { d.githubData.input.migrationRequired = true; }], ['migration action', d => { d.stage = 'migration'; }],
  ['used release', d => { d.state.consumedIds = ['used-101-a1']; }], ['no lock', d => { d.host.lock.held = false; }],
  ['wrong lock generation', d => { d.host.lock.revision = 1; }], ['wrong lock release', d => { d.host.lock.releaseId = 'used-102-a1'; }],
  ['paused', d => { d.host.paused = true; }], ['incident', d => { d.host.incident = true; }], ['residual lock', d => { d.host.residualLock = true; }],
  ['EBS missing', d => { d.storage.observation.mount.mounted = false; }], ['Docker unhealthy', d => { d.host.dockerHealthy = false; }],
  ['Nginx unhealthy', d => { d.host.nginxHealthy = false; }], ['MySQL unhealthy', d => { d.host.mysqlHealthy = false; }],
  ['no rollback', d => { d.host.rollback.ready = false; }], ['Vinext rollback', d => { d.host.rollback.slot = { ...d.host.rollback.slot, port: 3002 }; }],
  ['stale observation', d => { d.host.observedAt = NOW - 6; }], ['future observation', d => { d.host.observedAt = NOW + 1; }],
  ['expiry', d => { d.githubData.input.expiresAt = NOW; }], ['fake verified flag', d => { d.verified = true; }],
  ['API release false despite host true', d => { d.githubData.responses.variable.value = 'false'; }],
  ['OCI digest used as ZIP digest', d => { d.githubData.responses.artifacts.artifacts[0].digest = DIGEST; }],
  ['ZIP record differs from JSON input', d => {
    d.githubData.archiveBytes = zip({ ...d.githubData.record, runId: '102' });
    const artifact = d.githubData.responses.artifacts.artifacts[0]; artifact.digest = `sha256:${hash(d.githubData.archiveBytes)}`; artifact.size_in_bytes = d.githubData.archiveBytes.length;
  }],
];
for (const [name, modify] of cases) test(`guard refuses ${name}`, async () => { const d = fixture(); modify(d); const r = await assessRuntimeGuard(d, NOW); assert.equal(r.status, 'rejected'); assert.equal(r.executionAllowed, false); });
test('guard: correct reserved ID can be checked again, other IDs cannot', async () => {
  const d = fixture(); d.stage = 'before_create'; d.state.revision = 1; d.state.phase = 'preparing'; d.state.previous = { ...d.state.stable };
  d.state.activeReleaseId = 'used-101-a1'; d.state.consumedIds = ['used-101-a1']; d.host.lock.revision = 1;
  assert.equal((await assessRuntimeGuard(d, NOW)).status, 'mock_runtime_consistent');
  d.state.activeReleaseId = 'used-102-a1'; d.state.consumedIds = ['used-102-a1'];
  assert.equal((await assessRuntimeGuard(d, NOW)).status, 'rejected');
});
test('guard: rejected input/exception never reflects secret-like payload', async () => {
  const d = fixture(); d.githubData.record.approved = 'DUMMY_SECRET_SENTINEL';
  const r = await assessRuntimeGuard(d, NOW); assert.equal(JSON.stringify(r).includes('DUMMY_SECRET_SENTINEL'), false);
});
for (const [stage, phase] of [['before_switch', 'candidate_ready'], ['before_commit', 'verifying'], ['before_commit', 'committing']]) test(`guard: reserved release ${stage}/${phase} remains a simulation`, async () => {
  const d = fixture(); d.stage = stage; d.state.revision = 4; d.state.phase = phase; d.state.previous = { ...d.state.stable };
  d.state.candidate = { kind: 'nextjs', container: 'poll-next', port: 3101, image: `${IMAGE}@${DIGEST}` };
  d.state.activeReleaseId = 'used-101-a1'; d.state.consumedIds = ['used-101-a1']; d.host.lock.revision = 4;
  const r = await assessRuntimeGuard(d, NOW); assert.equal(r.status, 'mock_runtime_consistent'); assert.equal(r.executionAllowed, false);
  d.state.candidate.image = `${IMAGE}@sha256:${'f'.repeat(64)}`;
  assert.equal((await assessRuntimeGuard(d, NOW)).status, 'rejected');
});

function releaseFixture(state, ordinal) {
  const d = fixture(), sha = String(ordinal).repeat(40), runId = String(100 + ordinal), artifactId = String(201 + ordinal);
  const digest = `sha256:${(ordinal + 10).toString(16).repeat(64)}`, migrationDigest = `sha256:${String(ordinal + 3).repeat(64)}`;
  Object.assign(d.githubData.record, { sha, runId, digest, migrationDigest });
  Object.assign(d.githubData.input, { mainSha: sha, runId, artifactId, consumedIds: [...state.consumedIds],
    image: { repository: IMAGE, digest, revision: sha }, migration: { repository: IMAGE, digest: migrationDigest, revision: sha } });
  const r = d.githubData.responses;
  r.mainRef.object.sha = sha;
  Object.assign(r.run, { id: Number(runId), head_sha: sha, url: `${API}/actions/runs/${runId}` });
  r.jobs.jobs.forEach((job, index) => Object.assign(job, { id: 1000 + ordinal * 10 + index, run_id: Number(runId), run_url: r.run.url, head_sha: sha }));
  d.githubData.archiveBytes = zip(d.githubData.record);
  Object.assign(r.artifacts.artifacts[0], { id: Number(artifactId), name: `approved-release-${sha}-${runId}-1`,
    url: `${API}/actions/artifacts/${artifactId}`, archive_download_url: `${API}/actions/artifacts/${artifactId}/zip`,
    digest: `sha256:${hash(d.githubData.archiveBytes)}`, size_in_bytes: d.githubData.archiveBytes.length,
    workflow_run: { id: Number(runId), repository_id: 11, head_repository_id: 11, head_branch: 'main', head_sha: sha } });
  for (const p of PINNED_PATHS) d.workflow.files[p].ref = sha;
  d.state = structuredClone(state);
  d.host.mainSha = sha;
  Object.assign(d.host.lock, { releaseId: `used-${runId}-a1`, workspaceId: state.workspaceId, revision: state.revision });
  d.host.rollback.slot = structuredClone(state.stable);
  Object.assign(d.host.image, { digest, revision: sha, schemaSourceDigest: digest });
  return d;
}
test('M1: 異なるdigestの1・2・3回目でguardと永続記録が整合し、直前Next.jsを保持する', async () => {
  // OS一時領域だけの実保存＋模擬判定。Docker/Nginx統合・実配信の成功ではない。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-'));
  let lock, configLock;
  try {
    lock = acquireLocalLock(root);
    const store = createLocalStateStore(root, { now: () => NOW });
    let s = store.initialize(lock, fixture().state.stable, 'manual-initial-test');
    configLock = acquireLocalConfigLock(root);
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const d = releaseFixture(s, ordinal), before = structuredClone(s), oldStable = structuredClone(s.stable);
      const result = await assessRuntimeGuard(d, NOW);
      assert.equal(result.status, 'mock_runtime_consistent'); assert.equal(result.executionAllowed, false);
      assert.deepEqual(store.read(lock), before); // 開始前検査では確定記録/復旧先を変えない。
      const releaseId = `used-${100 + ordinal}-a1`;
      s = store.consume(lock, s.revision, releaseId);
      assert.equal(s.candidate, null); assert.deepEqual(s.previous, oldStable); assert.deepEqual(s.stable, oldStable);
      assert.equal(fs.existsSync(path.join(root, `${releaseId}.json`)), true);
      const check = async stage => {
        d.stage = stage; d.state = store.read(lock); d.host.lock.revision = d.state.revision;
        const r = await assessRuntimeGuard(d, NOW);
        assert.equal(r.status, 'mock_runtime_consistent'); assert.equal(r.executionAllowed, false);
      };
      await check('before_create');
      const candidate = { kind: 'nextjs', container: `next-${ordinal}`, port: oldStable.port === 3101 ? 3102 : 3101, image: `${IMAGE}@${d.githubData.record.digest}` };
      for (const phase of ['candidate_starting', 'candidate_checking', 'candidate_ready']) s = store.checkpoint(lock, s.revision, phase, candidate);
      const config = `proxy_pass http://127.0.0.1:${oldStable.port};\n`;
      let plan = { mode: 'local-plan', executionAllowed: false, phase: 'candidate_ready', previous: oldStable, candidate, configPath: '/etc/nginx/conf.d/siteflow.conf',
        expectedHash: hash(config), nextHash: hash(config.replace(`:${oldStable.port};`, `:${candidate.port};`)) };
      const receipt = store.prepareNginxRecovery(lock, configLock, s.revision, plan, Buffer.from(config));
      await check('before_switch');
      // 処理中の別digestを受け入れるようには緩和していない。
      const wrong = structuredClone(d); wrong.state.candidate.image = `${IMAGE}@sha256:${'f'.repeat(64)}`;
      assert.equal((await assessRuntimeGuard(wrong, NOW)).status, 'rejected');
      wrong.stage = 'before_consume'; // 処理中の状態を「消費前」と偽って比較を飛ばせない。
      assert.equal((await assessRuntimeGuard(wrong, NOW)).status, 'rejected');
      for (const type of ['backup_saved', 'staged_validated', 'intent_saved', 'config_installed', 'config_validated', 'reloaded']) plan = advanceNginxPlan(plan, { type, success: true, observation: null }, receipt);
      await check('before_commit');
      plan = advanceNginxPlan(plan, { type: 'public_checked', success: true, observation: { ...candidate, running: true, ready: true, httpStatus: 200, ok: true, consecutive: 3, freshConnections: true, workerGenerationConfirmed: true } }, receipt);
      await check('before_commit');
      plan = advanceNginxPlan(plan, { type: 'committed', success: true, observation: null }, receipt); s = store.read(lock);
      assert.deepEqual(s.stable, candidate); assert.deepEqual(s.lastKnownGood, candidate); assert.deepEqual(s.previous, oldStable);
      assert.equal(s.consumedIds.length, ordinal); assert.deepEqual(store.read(lock), s);
      assert.throws(() => store.consume(lock, s.revision, releaseId), /REUSE/);
      assert.equal((await assessRuntimeGuard(releaseFixture(s, ordinal), NOW)).status, 'rejected');
      assert.deepEqual(store.read(lock), s);
    }
    // 次版開始前の拒否で、前回確定版と復旧先の記録を破壊しない。
    for (const mutate of [d => { d.githubData.input.schemaHash = 'f'.repeat(64); }, d => { d.githubData.input.migrationRequired = true; }]) {
      const d = releaseFixture(s, 4); mutate(d);
      assert.equal((await assessRuntimeGuard(d, NOW)).status, 'rejected'); assert.deepEqual(store.read(lock), s);
    }
    s = store.consume(lock, s.revision, 'used-104-a1'); s = store.checkpoint(lock, s.revision, 'incident');
    assert.equal((await assessRuntimeGuard(releaseFixture(s, 5), NOW)).status, 'rejected');
    assert.throws(() => store.consume(lock, s.revision, 'used-105-a1'), /INCIDENT/); assert.deepEqual(store.read(lock), s);
    releaseLocalLock(configLock); configLock = null; releaseLocalLock(lock); lock = null;
  } finally {
    // 子プロセスや本番パスは操作しない。作成した専用一時ディレクトリだけを回収。
    if (configLock) releaseLocalLock(configLock);
    if (lock) releaseLocalLock(lock);
    const real = fs.realpathSync(root);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(real), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
    fs.rmSync(real, { recursive: true, force: true });
  }
});
