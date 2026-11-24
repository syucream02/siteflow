import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { prepareMockIntegration, runMockIntegration } from '../deploy/poll/integration.mjs';
import { acquireMockRelease, takeMockAcquisitionEvidence } from '../deploy/poll/acquire.mjs';
import { createMockTransport, PINNED_PATHS, MOCK_DOWNLOAD_HOST } from '../deploy/poll/transport.mjs';
import { pathChain } from '../deploy/poll/linux-storage.mjs';
import { acquireLocalLock, releaseLocalLock } from '../deploy/poll/lock.mjs';
import { createLocalStateStore, inspectLocalState } from '../deploy/poll/persistent-state.mjs';
import { openLocalStopRequester, openLocalStopReader } from '../deploy/poll/stop-control.mjs';
import { createDockerPlan, createBootstrapContainerConfiguration, takeContainerConfiguration } from '../deploy/poll/docker-plan.mjs';
// All API responses, credentials and image observations are synthetic; no real keys, tokens or network.
const BASE = 1700000000, NOW = BASE + 100, SHA = 'a'.repeat(40), DIGEST = 'sha256:'+'b'.repeat(64), SCHEMA = 'd'.repeat(64);
const IMAGE = 'ghcr.io/syucream02/siteflow', API = 'https://api.github.com/repos/syucream02/siteflow';
const digest = DIGEST, sha = SHA, schema = SCHEMA, GiB = 1024 ** 3;
const iso = n => new Date(n * 1000).toISOString();
const hash = x => createHash('sha256').update(x).digest('hex');
function storedZip(record) {
  const data = Buffer.from(JSON.stringify(record, null, 2)), name = Buffer.from('approved-release.json');
  const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4);
  l.writeUInt32LE(crc32(data), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6);
  c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28); c.writeUInt32LE(0x81a40000, 38);
  const offset = l.length + name.length + data.length, end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(c.length + name.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([l, name, data, c, name, end]);
}
function acquisitionFixture(ordinal = 1, edit = () => {}, onRequest = () => {}) {
  const SHA = ordinal.toString(16).repeat(40), RUN = 100 + ordinal;
  const repo = { id: 11, full_name: 'syucream02/siteflow' };
  const record = { schemaVersion: 1, repository: repo.full_name, workflow: '.github/workflows/ci.yml',
    sha: SHA, runId: String(RUN), attempt: '1', imageRepository: 'ghcr.io/syucream02/siteflow',
    digest: `sha256:${(ordinal + 10).toString(16).repeat(64)}`, migrationDigest: `sha256:${'c'.repeat(64)}`, schemaHash: 'd'.repeat(64), approved: true };
  const run = { id: RUN, workflow_id: 22, run_attempt: 1, path: '.github/workflows/ci.yml', url: `${API}/actions/runs/${RUN}`,
    repository: repo, head_repository: repo, event: 'push', head_branch: 'main', head_sha: SHA,
    status: 'completed', conclusion: 'success', created_at: iso(BASE), updated_at: iso(BASE + 80) };
  const job = (name, id, start, end) => ({ id, name, run_id: RUN, run_url: run.url, head_sha: SHA, head_branch: 'main',
    status: 'completed', conclusion: 'success', started_at: iso(BASE + start), completed_at: iso(BASE + end) });
  const bytes = storedZip(record);
  const artifact = { id: 202, name: `approved-release-${SHA}-${RUN}-1`, expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size_in_bytes: bytes.length,
    created_at: iso(BASE + 50), expires_at: iso(BASE + 86400), url: `${API}/actions/artifacts/202`,
    archive_download_url: `${API}/actions/artifacts/202/zip`, workflow_run: { id: RUN, repository_id: 11,
      head_repository_id: 11, head_branch: 'main', head_sha: SHA } };
  const d = { repository: repo, main: { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } },
    permission: { name: 'SITEFLOW_RELEASE_ENABLED', value: 'true', created_at: iso(BASE), updated_at: iso(BASE + 10) },
    workflow: { id: 22, path: '.github/workflows/ci.yml', state: 'active' }, run, attempt: structuredClone(run),
    runs: [structuredClone(run)], jobs: [job('docker-build', 1001, 1, 20), job('release-approved', 1002, 30, 60)],
    approvals: [{ state: 'approved', user: { login: 'syucream02', id: 44, type: 'User' }, environments: [{ id: 33, name: 'production' }] }],
    environment: { id: 33, name: 'production' }, artifacts: [structuredClone(artifact)], artifact, bytes, files: {},
    local: { image: { repository: record.imageRepository, digest: record.digest, revision: SHA },
      migration: { repository: record.imageRepository, digest: record.migrationDigest, revision: SHA },
      schemaHash: record.schemaHash, migrationRequired: false, consumedIds: [] },
    policy: { github: { repositoryId: 11, workflowId: 22, environmentId: 33, approverId: 44 }, workflow: { workflowId: 22, hashes: {} } } };
  for (const path of PINNED_PATHS) {
    const b = Buffer.from(`REVIEWED FIXTURE ${path}`);
    d.files[path] = { type: 'file', path, encoding: 'base64', size: b.length, content: b.toString('base64'),
      sha: createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex') };
    d.policy.workflow.hashes[path] = createHash('sha256').update(b).digest('hex');
  }
  edit(d);
  const seen = [], counts = new Map();
  const transport = createMockTransport({ now: () => NOW, exchange: async req => {
    const u = new URL(req.url), p = u.pathname, count = (counts.get(p) ?? 0) + 1; counts.set(p, count);
    seen.push(p); onRequest({ p, count, d, req });
    if (u.hostname === MOCK_DOWNLOAD_HOST) return { status: 200, headers: { 'content-type': 'application/zip' }, body: d.bytes };
    if (p.endsWith('/artifacts/202/zip')) return { status: 302, headers: { location: `https://${MOCK_DOWNLOAD_HOST}/zip` } };
    let body;
    if (p === '/repos/syucream02/siteflow') body = d.repository;
    else if (p.endsWith('/git/ref/heads/main')) body = d.main;
    else if (p.includes('/variables/')) body = d.permission;
    else if (p.endsWith('/actions/workflows/ci.yml')) body = d.workflow;
    else if (p.endsWith('/workflows/ci.yml/runs')) {
      const page = Number(u.searchParams.get('page')); body = { total_count: d.runs.length, workflow_runs: d.runs.slice((page - 1) * 100, page * 100) };
    } else if (p.endsWith('/attempts/1/jobs')) body = { total_count: d.jobs.length, jobs: d.jobs };
    else if (p.endsWith('/attempts/1')) body = d.attempt;
    else if (p.endsWith('/approvals')) body = d.approvals;
    else if (p.endsWith('/environments/production')) body = d.environment;
    else if (p.endsWith(`/runs/${RUN}/artifacts`)) body = { total_count: d.artifacts.length, artifacts: d.artifacts };
    else if (p.endsWith('/artifacts/202')) body = d.artifact;
    else if (p.includes('/contents/')) body = d.files[p.split('/contents/')[1]];
    else if (p.endsWith(`/runs/${RUN}`)) body = d.run;
    else throw new Error('UNEXPECTED_MOCK_ROUTE');
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };
  } });
  const config = { transport, credential: { authorization(time) { assert.ok(time >= BASE); return 'Bearer fixture-not-real'; } },
    policy: d.policy, local: d.local, now: () => NOW };
  return { d, config, seen };
}
function dockerFixture(port = 3001) {
  const sp = { mount: '/srv/siteflow-mysql', uuid: '11111111-2222-3333-4444-555555555555', volumeId: 'vol-11111111111111111',
    stateDirectory: '/srv/siteflow-mysql/poll-state', mysqlDataDirectory: '/srv/siteflow-mysql/data', minFreeBytes: 256 * 1024 * 1024 };
  const storage = { policy: sp, observation: { querySucceeded: true,
    mount: { target: sp.mount, realPath: sp.mount, source: '/dev/nvme1n1', uuid: sp.uuid, volumeId: sp.volumeId, fstype: 'xfs', options: ['rw'], deviceId: 2, mounted: true, encrypted: true },
    entries: pathChain(sp.stateDirectory).map(p => ({ path: p, realPath: p, type: 'directory', uid: 0, gid: 0, mode: p === sp.stateDirectory ? 0o700 : 0o755, symlink: false, deviceId: p.startsWith(sp.mount) ? 2 : 1 })),
    mysqlDataRealPath: sp.mysqlDataDirectory, freeBytes: GiB, freeInodes: 1000, writeProbeSucceeded: true } };
  const stable = { kind: 'nextjs', container: `current-${port}`, port, image: `sha256:${'e'.repeat(64)}` };
  const candidate = { kind: 'nextjs', container: 'poll-next', port: port === 3101 ? 3102 : 3101, image: `ghcr.io/syucream02/siteflow@${digest}` };
  const policy = { origin: 'https://siteflow.invalid', network: 'siteflow-production-database', databaseHost: 'mysql.siteflow.test', databaseName: 'siteflow_public_app', databaseUser: 'siteflow_app',
    runtimeEnvFile: `${sp.mount}/config/app-runtime.env`, passwordFile: `${sp.mount}/secrets/candidate/db-password`, authFile: `${sp.mount}/secrets/candidate/auth-secret`, caFile: `${sp.mount}/tls/server/ca.pem` };
  const files = Object.fromEntries(['runtimeEnvFile', 'passwordFile', 'authFile', 'caFile'].map(key => [key, { path: policy[key], realPath: policy[key], symlink: false, type: 'file',
    uid: ['passwordFile', 'authFile'].includes(key) ? 1000 : 0, mode: ['passwordFile', 'authFile'].includes(key) ? 0o400 : key === 'caFile' ? 0o644 : 0o600,
    bytes: 100, uuid: sp.uuid, parentProtected: true, links: 1 }]));
  return { record: { schemaVersion: 1, repository: 'syucream02/siteflow', workflow: '.github/workflows/ci.yml', sha, runId: '101', attempt: '1', imageRepository: 'ghcr.io/syucream02/siteflow', digest, migrationDigest: `sha256:${'c'.repeat(64)}`, schemaHash: schema, approved: true },
    stable, candidate, storage, policy, files,
    runtime: { environment: { mounted: true, uuidMatches: true, volumeMatches: true, rootOwned: true, symlinkFree: true, mysqlHealthy: true }, route: stable, containers: [{ ...stable, running: true, ready: true }], listeners: [{ port, container: stable.container }], configHash: 'f'.repeat(64) },
    env: { NODE_ENV: 'production', HOSTNAME: '0.0.0.0', PORT: '3000', SITEFLOW_WORKSPACE_MODE: 'public-integrated', SITEFLOW_PUBLIC_ORIGIN: policy.origin,
      SITEFLOW_DB_HOST: policy.databaseHost, SITEFLOW_DB_PORT: '3306', SITEFLOW_DB_NAME: policy.databaseName, SITEFLOW_DB_USER: policy.databaseUser, SITEFLOW_DB_TLS: 'required',
      SITEFLOW_DB_CA_FILE: '/run/siteflow/ca.pem', SITEFLOW_DB_PASSWORD_FILE: '/run/secrets/db-password', SITEFLOW_AUTH_SECRET_FILE: '/run/secrets/auth-secret' },
    image: { repoDigests: [candidate.image], revision: sha, schemaHash: schema, schemaSourceDigest: digest, os: 'linux', architecture: 'amd64', user: 'node', entrypoint: ['docker-entrypoint.sh'], cmd: ['node', 'server.js'] },
    resources: { availableMemoryBytes: GiB, rootFreeBytes: 8 * GiB, imageUnpackedBytes: 512 * 1024 * 1024, dockerHealthy: true, mysqlHealthy: true } };
}
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
function guardFixture() {
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

const healthy = slot => ({ ...slot, running: true, ready: true, httpStatus: 200, ok: true, consecutive: 3, freshConnections: true, workerGenerationConfirmed: true });
function setup(withConfiguration = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-'));
  const lock = acquireLocalLock(root), store = createLocalStateStore(root, { now: () => NOW });
  const d = dockerFixture();
  let bootstrap = null;
  if (withConfiguration) {
    const cfg = takeContainerConfiguration(createDockerPlan(d).configurationReceipt, d.candidate, 'used-101-a1').configuration;
    cfg.portBindings[0].hostPort = d.stable.port;
    bootstrap = createBootstrapContainerConfiguration(d.stable, 'manual-integration-bootstrap', cfg);
  }
  const state = store.initialize(lock, d.stable, 'manual-integration-bootstrap', bootstrap);
  releaseLocalLock(lock); return { root, store, state };
}
function cleanup(c) {
  const root = fs.realpathSync(c.root);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
  fs.rmSync(root, { recursive: true, force: true });
}
function local(name, run, withConfiguration = false) { test(name, async () => { const c = setup(withConfiguration); try { await run(c); } finally { cleanup(c); } }); }
async function prepare(c, ordinal = 1, edit = () => {}, onRequest = () => {}) {
  const f = acquisitionFixture(ordinal, edit, onRequest);
  f.config.local.consumedIds = [...c.state.consumedIds];
  const context = await prepareMockIntegration({ auth: { mode: 'mock-only', getCredential: async () => f.config.credential },
    transport: f.config.transport, policy: f.config.policy, local: f.config.local, now: () => NOW });
  return { context, f };
}
function observer(f, hook = () => {}) {
  return async (stage, state, selected) => {
    const g = guardFixture(), d = dockerFixture(state.stable.port);
    const record = { schemaVersion: 1, repository: 'syucream02/siteflow', workflow: '.github/workflows/ci.yml', sha: f.d.local.image.revision,
      runId: String(f.d.run.id), attempt: '1', imageRepository: IMAGE, digest: f.d.local.image.digest, migrationDigest: f.d.local.migration.digest, schemaHash: SCHEMA, approved: true };
    const candidate = selected ?? { kind: 'nextjs', container: `candidate-${record.runId}`, port: state.stable.port === 3101 ? 3102 : 3101, image: `${IMAGE}@${record.digest}` };
    const text = `server {\n location / {\n  proxy_pass http://127.0.0.1:${state.stable.port};\n  proxy_set_header Host $host;\n  proxy_set_header X-Forwarded-Proto $scheme;\n }\n}\n`;
    const host = { ...g.host, mainSha: record.sha, rollback: { slot: state.stable, running: true, ready: true, configHash: hash(text) },
      image: { repository: IMAGE, digest: record.digest, revision: record.sha, schemaHash: SCHEMA, schemaSourceDigest: record.digest } };
    d.stable = state.stable; d.candidate = candidate; d.record = record;
    Object.assign(d.image, { repoDigests: [candidate.image], revision: record.sha, schemaSourceDigest: record.digest });
    d.runtime.route = state.stable; d.runtime.containers = [healthy(state.stable)]; d.runtime.listeners = [{ port: state.stable.port, container: state.stable.container }]; d.runtime.configHash = hash(text);
    const nginx = { origin: 'https://siteflow.invalid', config: { path: '/etc/nginx/conf.d/siteflow.conf', realPath: '/etc/nginx/conf.d/siteflow.conf', uid: 0, mode: 0o600,
      symlink: false, links: 1, text, reviewedHash: hash(text), parentEntries: pathChain('/etc/nginx/conf.d').map(p => ({ path: p, realPath: p, type: 'directory', uid: 0, gid: 0, mode: 0o755, symlink: false, deviceId: 1 })) },
      observed: { currentUpstreamPort: state.stable.port, stable: healthy(state.stable), candidate: healthy(candidate), configurationExclusive: true, nginxHealthy: true } };
    const data = { storage: g.storage, host, docker: d, nginx, event: { success: true, observation: stage === 'public_checked' || stage === 'before_commit' ? healthy(candidate) : stage === 'rollback_checked' ? healthy(state.previous) : null },
      recovery: { environment: d.runtime.environment, containers: [healthy(state.stable), healthy(candidate)], route: state.stable, configMatches: true,
        nginxConfigHash: hash(text), configurationExclusive: true, backupHash: state.nginxRecovery?.beforeHash, backupFile: state.nginxRecovery?.backupFile } };
    await hook(stage, data, state, candidate); return data;
  };
}
function run(c, prepared, hook) { return runMockIntegration(prepared.context, { directory: c.root, now: () => NOW, observe: observer(prepared.f, hook) }); }

local('H1: complete mock acquisition -> durable consume -> plans -> journal commit, never execution permission', async c => {
  const p = await prepare(c), r = await run(c, p);
  assert.equal(r.status, 'mock_committed'); assert.equal(r.executionAllowed, false); assert.equal(r.authenticity, 'not-established');
  assert.equal(r.state.stable.port, 3101); assert.equal(r.state.previous.port, 3001); assert.equal(r.state.stableReleaseId, 'used-101-a1');
  assert.deepEqual(r.state.consumedIds, ['used-101-a1']); assert.equal(r.plan.docker.executionAllowed, false);
  assert.ok(r.trace.findIndex(s => s.stage === 'consumed') < r.trace.findIndex(s => s.stage === 'before_create'));
  assert.ok(r.state.nginxRecovery.beforeHash !== r.state.nginxRecovery.afterHash);
  assert.deepEqual(inspectLocalState(c.root).state, r.state);
  const phases = r.trace.map(s => s.phase);
  assert.deepEqual(phases, ['idle', 'preparing', 'preparing', 'candidate_starting', 'candidate_checking', 'candidate_ready', 'candidate_ready',
    'candidate_ready', 'candidate_ready', 'switching', 'switching', 'switching', 'verifying', 'committing', 'committing', 'committed']);
  assert.ok(r.trace.every((s, i) => s.executionAllowed === false && (i === 0 || s.revision >= r.trace[i - 1].revision)));
});
local('H1: second and third distinct digests preserve previous Next.js and durable consumed IDs', async c => {
  let previous = c.state.stable;
  for (const n of [1, 2, 3]) {
    const p = await prepare(c, n), r = await run(c, p);
    assert.equal(r.status, 'mock_committed'); assert.deepEqual(r.state.previous, previous);
    assert.equal(r.state.stable.port, n === 2 ? 3102 : 3101);
    assert.equal(r.state.stable.image, `${IMAGE}@${p.f.d.local.image.digest}`);
    c.state = r.state; previous = r.state.stable;
  }
  assert.deepEqual(c.state.consumedIds, ['used-101-a1', 'used-102-a1', 'used-103-a1']);
});
local('H1: forged, cloned, modified contexts rejected; original immutable and single-use', async c => {
  const p = await prepare(c);
  for (const fake of [{ verified: true }, { ...p.context }, structuredClone(p.context)]) await assert.rejects(runMockIntegration(fake, { directory: c.root, now: () => NOW, observe: observer(p.f) }), /INVALID_OR_USED/);
  assert.throws(() => { p.context.releaseId = 'used-999-a1'; }, TypeError);
  assert.equal((await run(c, p)).status, 'mock_committed'); await assert.rejects(run(c, p), /INVALID_OR_USED/);
});
local('H1: concurrent same-context use has exactly one invocation', async c => {
  const p = await prepare(c), first = run(c, p);
  await assert.rejects(run(c, p), /INVALID_OR_USED/); assert.equal((await first).status, 'mock_committed');
});
local('H1: repeated ID rejected after commit', async c => {
  const p = await prepare(c), duplicate = await prepare(c);
  assert.equal((await run(c, p)).status, 'mock_committed'); assert.equal((await run(c, duplicate)).status, 'rejected');
  assert.deepEqual(inspectLocalState(c.root).state.consumedIds, ['used-101-a1']);
});
local('H1: lock conflict refuses consumption and context retry', async c => {
  const p = await prepare(c), lock = acquireLocalLock(c.root);
  try { assert.equal((await run(c, p)).status, 'rejected'); } finally { releaseLocalLock(lock); }
  assert.deepEqual(inspectLocalState(c.root).state.consumedIds, []); await assert.rejects(run(c, p), /INVALID_OR_USED/);
});
local('H1: lock-protected reread rejects stale consumed snapshot', async c => {
  const p = await prepare(c), lock = acquireLocalLock(c.root);
  c.store.consume(lock, c.state.revision, 'used-999-a1'); releaseLocalLock(lock);
  assert.equal((await run(c, p)).status, 'rejected'); assert.deepEqual(inspectLocalState(c.root).state.consumedIds, ['used-999-a1']);
});
for (const [name, edit] of [
  ['wrong approver', d => { d.approvals[0].user.id = 45; }], ['approval absent', d => { d.approvals = []; }],
  ['CI failed', d => { d.runs[0].conclusion = 'failure'; }], ['attempt2', d => { d.runs[0].run_attempt = 2; }],
  ['main mismatch', d => { d.main.object.sha = 'f'.repeat(40); }], ['workflow hash', d => { d.policy.workflow.hashes.Dockerfile = 'f'.repeat(64); }],
  ['release script hash', d => { d.policy.workflow.hashes['deploy/release-record.mjs'] = 'f'.repeat(64); }],
  ['ZIP tamper', d => { d.bytes[40] ^= 1; }], ['ZIP digest', d => { d.artifact.digest = `sha256:${'f'.repeat(64)}`; }],
  ['OCI mismatch', d => { d.local.image.digest = `sha256:${'f'.repeat(64)}`; }], ['schema mismatch', d => { d.local.schemaHash = 'f'.repeat(64); }],
  ['migration required', d => { d.local.migrationRequired = true; }], ['release disabled', d => { d.permission.value = 'false'; }],
]) local(`H1: acquisition rejects ${name}`, async c => { await assert.rejects(prepare(c, 1, edit), /PREPARATION_REJECTED/); assert.deepEqual(inspectLocalState(c.root).state.consumedIds, []); });
for (const [name, modify] of [
  ['main changed', f => { f.d.main.object.sha = 'f'.repeat(40); }], ['approval removed', f => { f.d.approvals = []; }],
  ['permission withdrawn', f => { f.d.permission.value = 'false'; }], ['workflow altered', f => { f.d.files.Dockerfile.content = Buffer.from('CHANGED').toString('base64'); }],
]) local(`H1: fresh guard rejects ${name}`, async c => { const p = await prepare(c); modify(p.f); assert.equal((await run(c, p)).status, 'rejected'); });
for (const stage of ['before_consume', 'before_create', 'candidate_starting', 'candidate_ready', 'before_switch', 'intent_saved', 'config_installed', 'reloaded', 'before_commit']) local(`H1/H3: durable stop at ${stage}`, async c => {
  const p = await prepare(c); let sent = false;
  const result = await run(c, p, (s, data, state) => { if (s === stage) { openLocalStopRequester(c.root, state.workspaceId, { now: () => NOW }).requestStop(); sent = true; } });
  assert.ok(sent); assert.equal(result.status, 'rejected'); assert.equal(result.executionAllowed, false);
  assert.equal(openLocalStopReader(c.root, c.state.workspaceId).read().status, 'requested'); assert.ok(!result.trace.some(s => s.stage === 'committed'));
  if (stage !== 'before_consume') assert.equal(result.state.phase, 'incident');
});
local('H1/H3: stopped before start rejects without consume', async c => {
  const p = await prepare(c); openLocalStopRequester(c.root, c.state.workspaceId, { now: () => NOW }).requestStop();
  const r = await run(c, p); assert.equal(r.status, 'rejected'); assert.deepEqual(r.state.consumedIds, []);
});
local('H1: incident rejects new integration without clearing', async c => {
  const p = await prepare(c), lock = acquireLocalLock(c.root); let s = c.store.consume(lock, 0, 'used-999-a1');
  c.store.checkpoint(lock, s.revision, 'incident'); releaseLocalLock(lock);
  const r = await run(c, p); assert.equal(r.status, 'rejected'); assert.equal(r.state.phase, 'incident');
});
for (const stage of ['candidate_starting', 'candidate_checking', 'candidate_ready', 'backup_saved', 'staged_validated', 'config_validated', 'reloaded', 'public_checked']) local(`H1/H2: failed mock operation at ${stage}`, async c => {
  const p = await prepare(c), r = await run(c, p, (s, data) => { if (s === stage) data.event.success = false; });
  assert.notEqual(r.status, 'mock_committed'); assert.equal(r.state.phase, 'incident'); assert.equal(r.state.stable.port, 3001);
});
local('H1/H2: failed rollback retains incident and previous Next.js', async c => {
  const p = await prepare(c), r = await run(c, p, (s, data) => { if (s === 'public_checked' || s === 'rollback_reloaded') data.event.success = false; });
  assert.equal(r.status, 'incident'); assert.equal(r.state.phase, 'incident'); assert.equal(r.state.stable.port, 3001); assert.equal(r.plan.nginx.reason, 'ROLLBACK_FAILED');
});
for (const stage of ['before_create', 'config_installed', 'reloaded', 'before_commit']) local(`H1/H2: simulated interruption at ${stage}`, async c => {
  const p = await prepare(c), r = await run(c, p, s => { if (s === stage) throw new Error('SIMULATED_TERMINATION'); });
  assert.equal(r.status, 'rejected'); assert.equal(r.state.phase, 'incident'); assert.equal(r.recovery.newDeploymentsAllowed, false);
  assert.equal(inspectLocalState(c.root).state.phase, 'incident');
  if (stage !== 'before_create') { assert.ok(r.state.nginxRecovery.beforeHash); assert.ok(r.state.nginxRecovery.backupFile); }
});
for (const [name, edit] of [
  ['OCI runtime digest', d => { d.host.image.digest = `sha256:${'f'.repeat(64)}`; }], ['Docker revision', d => { d.docker.image.revision = 'f'.repeat(40); }],
  ['migration command', d => { d.docker.image.cmd = ['node', 'deploy/migrate.mjs']; }], ['Vinext rollback', d => { d.host.rollback.slot.port = 3002; }],
  ['Vinext candidate', d => { d.docker.candidate.port = 3002; }],
]) local(`H1: plan rejects ${name}`, async c => {
  const p = await prepare(c), r = await run(c, p, (s, data) => { if (s === 'before_consume' || s === 'before_create') edit(data); });
  assert.equal(r.status, 'rejected'); assert.equal(r.executionAllowed, false);
});
local('H1: corrupt durable state is not replaced with invented state', async c => {
  const p = await prepare(c); fs.writeFileSync(path.join(c.root, 'state.json'), '{broken');
  const r = await run(c, p); assert.equal(r.status, 'rejected'); assert.equal(r.recovery.status, 'incident');
  assert.equal(fs.readFileSync(path.join(c.root, 'state.json'), 'utf8'), '{broken');
});
local('fix4: initial state failure records unknown incident and plans a mock notice', async c => {
  const p = await prepare(c); fs.writeFileSync(path.join(c.root, 'state.json'), '{broken');
  const r = await run(c, p);
  assert.equal(r.status, 'rejected'); assert.equal(r.incident.status, 'recorded');
  assert.equal(r.incident.notification.status, 'planned');
  const lock = acquireLocalLock(c.root);
  try {
    const record = c.store.listIncidents(lock)[0];
    assert.equal(record.stateConfidence, 'unconfirmed'); assert.equal(record.phase, 'unknown');
    assert.equal(record.stable, null); assert.equal(record.releaseId, null);
  } finally { releaseLocalLock(lock); }
  assert.equal(fs.readFileSync(path.join(c.root, 'state.json'), 'utf8'), '{broken');
});
local('fix4: repeated handling of the same incident suppresses its second notification', async c => {
  const a = await run(c, await prepare(c), (s, data) => { if (s === 'candidate_starting') data.event.success = false; });
  assert.equal(a.incident.notification.status, 'planned');
  const b = await run(c, await prepare(c));
  assert.equal(b.status, 'rejected'); assert.equal(b.incident.incidentId, a.incident.incidentId);
  assert.equal(b.incident.notification.status, 'suppressed'); assert.equal(b.incident.notification.incidentResolved, false);
});
local('fix4: a different new incident gets its own notification plan', async c => {
  const a = await run(c, await prepare(c), (s, data) => { if (s === 'candidate_starting') data.event.success = false; });
  const lock = acquireLocalLock(c.root);
  try {
    const saved = c.store.recordIncident(lock, { reason: 'RECOVERY_UNCERTAIN', stage: 'post_switch', nginxMatch: 'unknown', dockerMatch: 'unknown', recoveryPhase: 'uncertain' });
    assert.notEqual(saved.record.incidentId, a.incident.incidentId);
    assert.equal(c.store.prepareIncidentNotification(lock, saved.record.incidentId).status, 'planned');
  } finally { releaseLocalLock(lock); }
});
local('fix4: broken workspace is retained when incident storage cannot be established', async c => {
  const p = await prepare(c), file = path.join(c.root, 'workspace.json'); fs.writeFileSync(file, '{broken-workspace');
  const r = await run(c, p);
  assert.equal(r.status, 'rejected'); assert.equal(r.incident.status, 'record_not_confirmed');
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken-workspace');
});
local('fix4: notification plan failure preserves the already recorded incident', async c => {
  const p = await prepare(c);
  const r = await runMockIntegration(p.context, { directory: c.root,
    now: () => fs.readdirSync(c.root).some(n => n.startsWith('incident-record-')) ? NaN : NOW,
    observe: observer(p.f, (s, data) => { if (s === 'candidate_starting') data.event.success = false; }) });
  assert.equal(r.status, 'rejected'); assert.equal(r.incident.status, 'recorded');
  assert.equal(r.incident.notification.status, 'plan_not_confirmed');
  assert.ok(fs.readdirSync(c.root).some(n => n.startsWith('incident-record-')));
  assert.equal(inspectLocalState(c.root).status, 'incident');
});
local('H1: acquisition evidence bound to original and single-use', async () => {
  const f = acquisitionFixture(), result = await acquireMockRelease(f.config);
  assert.throws(() => takeMockAcquisitionEvidence({ ...result }), /INVALID_OR_USED/);
  const e = takeMockAcquisitionEvidence(result); assert.equal(e.githubData.record.approved, true);
  assert.throws(() => takeMockAcquisitionEvidence(result), /INVALID_OR_USED/);
  const changed = await acquireMockRelease(f.config); changed.releaseId = 'used-999-a1'; assert.throws(() => takeMockAcquisitionEvidence(changed), /INVALID_OR_USED/);
});
local('H1: valid ZIP digest does not hide a different JSON release identity', async c => {
  await assert.rejects(prepare(c, 1, d => {
    const record = { schemaVersion: 1, repository: 'syucream02/siteflow', workflow: '.github/workflows/ci.yml', sha: d.run.head_sha,
      runId: '999', attempt: '1', imageRepository: IMAGE, digest: d.local.image.digest, migrationDigest: d.local.migration.digest, schemaHash: SCHEMA, approved: true };
    d.bytes = storedZip(record); d.artifact.digest = `sha256:${hash(d.bytes)}`; d.artifact.size_in_bytes = d.bytes.length;
    d.artifacts = [structuredClone(d.artifact)];
  }), /PREPARATION_REJECTED/);
});
for (const stage of ['before_create', 'before_switch', 'before_commit']) local(`H1: current GitHub permission loss at ${stage} is rejected`, async c => {
  const p = await prepare(c), r = await run(c, p, s => { if (s === stage) p.f.d.permission.value = 'false'; });
  assert.equal(r.status, 'rejected'); assert.equal(r.state.phase, 'incident'); assert.equal(r.state.stable.port, 3001);
  assert.deepEqual(r.state.consumedIds, ['used-101-a1']);
});
local('H1/H2: corrupt recovery backup before switch progression is refused', async c => {
  const p = await prepare(c), r = await run(c, p, (s, data, state) => {
    if (s === 'backup_saved') fs.writeFileSync(path.join(c.root, state.nginxRecovery.backupFile), '{}');
  });
  assert.equal(r.status, 'rejected'); assert.equal(r.recovery.status, 'incident');
  assert.equal(inspectLocalState(c.root).status, 'incident');
});
local('H1: independent contexts contend for one real local deployment lock', async c => {
  const first = await prepare(c), second = await prepare(c);
  let blocked;
  const r = await run(c, first, async s => { if (s === 'before_consume') blocked = await run(c, second); });
  assert.equal(blocked.status, 'rejected'); assert.equal(r.status, 'mock_committed');
  assert.deepEqual(r.state.consumedIds, ['used-101-a1']);
});
local('H1: injected clock expiry refuses execution without ID consumption', async c => {
  const p = await prepare(c);
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => BASE + 1000, observe: observer(p.f) });
  assert.equal(r.status, 'rejected'); assert.deepEqual(inspectLocalState(c.root).state.consumedIds, []);
});
test('H1: integration has no network/command client or real authorization export', () => {
  const source = fs.readFileSync(new URL('../deploy/poll/integration.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(https|http|net|child_process)|fetch\s*\(|executionAllowed:\s*true/);
  assert.equal((source.match(/export (?:async )?function /g) ?? []).length, 2);
});
for (const stage of ['config_installed', 'reloaded', 'before_commit']) local(`High1: expiry at ${stage} blocks forward but durably completes saved rollback`, async c => {
  const p = await prepare(c); let clock = NOW;
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => clock, observe: observer(p.f, s => { if (s === stage) clock = BASE + 3650; }) });
  assert.equal(r.status, 'rejected'); assert.equal(r.executionAllowed, false); assert.equal(r.state.phase, 'incident');
  assert.equal(r.state.stable.port, 3001); assert.deepEqual(r.state.consumedIds, ['used-101-a1']);
  assert.deepEqual(r.trace.filter(t => t.stage.startsWith('rollback')).map(t => t.stage), ['rollback_restored', 'rollback_validated', 'rollback_reloaded', 'rollback_checked']);
  assert.ok(!r.trace.some(t => t.stage === 'committed'));
  assert.equal(inspectLocalState(c.root).state.nginxRecovery.operation, 'rollback_checked');
});
local('High1: approval expires during rollback without blocking recovery records', async c => {
  const p = await prepare(c); let clock = NOW;
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => clock, observe: observer(p.f, (s, data) => {
    if (s === 'public_checked') data.event.success = false;
    if (s === 'rollback_restored') clock = BASE + 3651;
  }) });
  assert.equal(r.status, 'incident'); assert.equal(r.state.phase, 'incident'); assert.equal(r.state.stable.port, 3001);
  assert.equal(r.state.updatedAt, BASE + 3651); assert.equal(r.state.nginxRecovery.operation, 'rollback_checked');
});
local('High1: expiry before consumption starts no deployment and consumes no ID', async c => {
  const p = await prepare(c);
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => BASE + 3650, observe: observer(p.f) });
  assert.equal(r.status, 'rejected'); assert.deepEqual(r.state.consumedIds, []); assert.equal(r.state.phase, 'idle');
});
for (const [label, value] of [['backward', NOW - 1], ['NaN', NaN], ['null', null]]) local(`High1: ${label} clock cannot erase uncertainty or use fabricated timestamps`, async c => {
  const p = await prepare(c); let clock = NOW;
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => clock, observe: observer(p.f, s => { if (s === 'reloaded') clock = value; }) });
  assert.equal(r.status, 'rejected'); assert.equal(inspectLocalState(c.root).status, 'incident');
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.root, 'incident.json'), 'utf8')).reason, 'INTEGRATION_OUTCOME_UNCERTAIN');
  assert.ok(!r.trace.some(t => t.stage === 'committed')); assert.equal(r.executionAllowed, false);
});
local('High1: expiry plus durable stop still allows rollback without clearing stop', async c => {
  const p = await prepare(c); let clock = NOW;
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => clock, observe: observer(p.f, (s, data, state) => {
    if (s === 'reloaded') { clock = BASE + 3650; openLocalStopRequester(c.root, state.workspaceId, { now: () => clock }).requestStop(); }
  }) });
  assert.equal(r.status, 'rejected'); assert.equal(r.state.phase, 'incident'); assert.equal(r.state.nginxRecovery.operation, 'rollback_checked');
  assert.equal(openLocalStopReader(c.root, c.state.workspaceId).read().status, 'requested');
});
local('High2: integration persists actual plan configuration and promotes it on each commit', async c => {
  let previous = structuredClone(c.state.stableConfiguration);
  for (const n of [1, 2, 3]) {
    const p = await prepare(c, n), r = await run(c, p); assert.equal(r.status, 'mock_committed'); assert.equal(r.state.schemaVersion, 3);
    assert.equal(r.state.stableConfiguration.releaseId, `used-${100 + n}-a1`);
    assert.deepEqual(r.state.stableConfiguration.slot, r.state.stable);
    assert.deepEqual(r.state.previousConfiguration, previous);
    assert.equal(r.state.stableConfiguration.configuration.portBindings[0].hostPort, r.state.stable.port);
    c.state = r.state; previous = structuredClone(r.state.stableConfiguration);
  }
}, true);
local('High1: persistence failure during expired rollback stays incident rather than claiming restoration', async c => {
  const p = await prepare(c); let clock = NOW;
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => clock, observe: observer(p.f, s => {
    if (s === 'reloaded') clock = BASE + 3650;
    if (s === 'rollback_restored') fs.writeFileSync(path.join(c.root, 'pending.json'), '{}');
  }) });
  assert.equal(r.status, 'rejected'); assert.equal(inspectLocalState(c.root).status, 'incident');
  assert.ok(!r.trace.some(t => t.stage === 'rollback_checked' || t.stage === 'committed'));
});
local('High1: incident marker write failure retains owned deployment lock', async c => {
  const p = await prepare(c); let clock = NOW;
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => clock, observe: observer(p.f, s => {
    if (s === 'reloaded') { clock = NaN; fs.mkdirSync(path.join(c.root, 'incident.json')); }
  }) });
  assert.equal(r.status, 'rejected'); assert.throws(() => acquireLocalLock(c.root), /EEXIST/);
  assert.ok(fs.existsSync(path.join(c.root, 'used-101-a1.json'))); assert.equal(r.executionAllowed, false);
});
for (const [stage, expiryRead] of [['before_consume', 4], ['intent_saved', 3], ['before_commit', 4]]) local(`Review1: ${stage} persistent-record clock crossing deadline cannot advance`, async c => {
  const p = await prepare(c); let boundary = false, reads = 0;
  const r = await runMockIntegration(p.context, { directory: c.root, now: () => boundary && ++reads >= expiryRead ? BASE + 3650 : NOW,
    observe: observer(p.f, s => { if (s === stage) boundary = true; }) });
  assert.equal(r.status, 'rejected'); assert.equal(r.executionAllowed, false); assert.ok(!r.trace.some(t => t.stage === 'committed'));
  if (stage === 'before_consume') { assert.equal(r.state.phase, 'idle'); assert.deepEqual(r.state.consumedIds, []); }
  else { assert.equal(r.state.phase, 'incident'); assert.equal(r.state.stable.port, 3001); }
  assert.notEqual(inspectLocalState(c.root).state?.phase, 'committed');
});
