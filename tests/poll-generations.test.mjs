import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createLocalStateStore, inspectLocalState } from '../deploy/poll/persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock } from '../deploy/poll/lock.mjs';
import { openLocalStopRequester, openLocalStopReader } from '../deploy/poll/stop-control.mjs';
import { createNginxPlan, advanceNginxPlan } from '../deploy/poll/nginx-plan.mjs';
import { pathChain } from '../deploy/poll/linux-storage.mjs';
import { createBootstrapContainerConfiguration, createDockerPlan, takeContainerConfiguration } from '../deploy/poll/docker-plan.mjs';
import { prepareMockIntegration, runMockIntegration } from '../deploy/poll/integration.mjs';
import { createMockTransport, PINNED_PATHS, MOCK_DOWNLOAD_HOST } from '../deploy/poll/transport.mjs';
import { createGenerationCleanup, validateCleanupRecord } from '../deploy/poll/generations.mjs';
// Copied synthetic fixture builders only; no test module imports, credentials or live adapters.
const NOW = 1700000100, IMAGE = 'ghcr.io/syucream02/siteflow@', ORIGIN = 'https://siteflow.invalid', GiB = 1024 ** 3;
const hash = b => createHash('sha256').update(b).digest('hex');
const healthy = slot => ({ ...slot, running: true, ready: true, httpStatus: 200, ok: true, consecutive: 3, freshConnections: true, workerGenerationConfirmed: true });
const configText = port => `server {\n location / {\n  proxy_pass http://127.0.0.1:${port};\n  proxy_set_header Host $host;\n  proxy_set_header X-Forwarded-Proto $scheme;\n }\n}\n`;
function storage() {
  const policy = { mount: '/srv/siteflow-mysql', uuid: '11111111-2222-3333-4444-555555555555', volumeId: 'vol-11111111111111111', stateDirectory: '/srv/siteflow-mysql/poll-state', mysqlDataDirectory: '/srv/siteflow-mysql/data', minFreeBytes: 256 * 1024 ** 2 };
  return { policy, observation: { querySucceeded: true,
    mount: { target: policy.mount, realPath: policy.mount, source: '/dev/nvme1n1', uuid: policy.uuid, volumeId: policy.volumeId, fstype: 'xfs', options: ['rw'], deviceId: 2, mounted: true, encrypted: true },
    entries: pathChain(policy.stateDirectory).map(p => ({ path: p, realPath: p, type: 'directory', uid: 0, gid: 0, mode: p === policy.stateDirectory ? 0o700 : 0o755, symlink: false, deviceId: p.startsWith(policy.mount) ? 2 : 1 })),
    mysqlDataRealPath: policy.mysqlDataDirectory, freeBytes: GiB, freeInodes: 1000, writeProbeSucceeded: true } };
}
function configuration(slot) {
  return { entrypoint: ['node'], cmd: ['server.js'], user: '1000:1000', workingDir: '/app',
    env: { NODE_ENV: 'production', HOSTNAME: '0.0.0.0', PORT: '3000', SITEFLOW_WORKSPACE_MODE: 'public-integrated', SITEFLOW_PUBLIC_ORIGIN: ORIGIN,
      SITEFLOW_DB_HOST: 'mysql.siteflow.test', SITEFLOW_DB_PORT: '3306', SITEFLOW_DB_NAME: 'siteflow_public_app', SITEFLOW_DB_USER: 'siteflow_app', SITEFLOW_DB_TLS: 'required',
      SITEFLOW_DB_CA_FILE: '/run/siteflow/ca.pem', SITEFLOW_DB_PASSWORD_FILE: '/run/secrets/db-password', SITEFLOW_AUTH_SECRET_FILE: '/run/secrets/auth-secret' },
    mounts: [
      { type: 'bind', source: '/srv/siteflow-mysql/secrets/candidate/db-password', target: '/run/secrets/db-password', readOnly: true },
      { type: 'bind', source: '/srv/siteflow-mysql/secrets/candidate/auth-secret', target: '/run/secrets/auth-secret', readOnly: true },
      { type: 'bind', source: '/srv/siteflow-mysql/tls/server/ca.pem', target: '/run/siteflow/ca.pem', readOnly: true },
    ], portBindings: [{ hostIp: '127.0.0.1', hostPort: slot.port, containerPort: 3000 }], networkMode: 'siteflow-production-database', privileged: false, readonlyRootfs: true,
    capAdd: [], capDrop: ['ALL'], securityOpt: ['no-new-privileges:true'], memory: 384 * 1024 ** 2, memorySwap: 384 * 1024 ** 2, nanoCpus: 500000000, pidsLimit: 128,
    ulimits: { core: { soft: 0, hard: 0 } }, tmpfs: { '/tmp': 'rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777' }, restartPolicy: 'no', logDriver: 'none', stopTimeout: 30 };
}
function candidatePlan(stable, candidate, n) {
  const cfg = configuration(candidate), f = storage();
  const policy = { origin: ORIGIN, network: cfg.networkMode, databaseHost: cfg.env.SITEFLOW_DB_HOST, databaseName: cfg.env.SITEFLOW_DB_NAME, databaseUser: cfg.env.SITEFLOW_DB_USER,
    runtimeEnvFile: '/srv/siteflow-mysql/config/app-runtime.env', passwordFile: cfg.mounts[0].source, authFile: cfg.mounts[1].source, caFile: cfg.mounts[2].source };
  const files = Object.fromEntries(['runtimeEnvFile', 'passwordFile', 'authFile', 'caFile'].map(key => [key, { path: policy[key], realPath: policy[key], symlink: false, type: 'file',
    uid: ['passwordFile', 'authFile'].includes(key) ? 1000 : 0, mode: ['passwordFile', 'authFile'].includes(key) ? 0o400 : key === 'caFile' ? 0o644 : 0o600, bytes: 100, uuid: f.policy.uuid, parentProtected: true, links: 1 }]));
  const record = { schemaVersion: 1, repository: 'syucream02/siteflow', workflow: '.github/workflows/ci.yml', sha: 'a'.repeat(40), runId: String(200 + n), attempt: '1', imageRepository: IMAGE.slice(0, -1),
    digest: candidate.image.slice(IMAGE.length), migrationDigest: `sha256:${'e'.repeat(64)}`, schemaHash: 'd'.repeat(64), approved: true };
  return createDockerPlan({ record, stable, candidate, storage: f, policy, files, env: cfg.env,
    runtime: { environment: { mounted: true, uuidMatches: true, volumeMatches: true, rootOwned: true, symlinkFree: true, mysqlHealthy: true }, route: stable,
      containers: [healthy(stable)], listeners: [{ port: stable.port, container: stable.container }], configHash: hash(configText(stable.port)) },
    image: { repoDigests: [candidate.image], revision: record.sha, schemaHash: record.schemaHash, schemaSourceDigest: record.digest, os: 'linux', architecture: 'amd64', user: 'node', entrypoint: ['docker-entrypoint.sh'], cmd: ['node', 'server.js'] },
    resources: { availableMemoryBytes: GiB, rootFreeBytes: 8 * GiB, imageUnpackedBytes: 512 * 1024 ** 2, dockerHealthy: true, mysqlHealthy: true } });
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-')), lock = acquireLocalLock(root);
  const store = createLocalStateStore(root, { now: () => NOW });
  const stable = { kind: 'nextjs', container: 'initial-next', port: 3001, image: `${IMAGE}sha256:${'a'.repeat(64)}` };
  const state = store.initialize(lock, stable, 'manual-initial-reviewed', createBootstrapContainerConfiguration(stable, 'manual-initial-reviewed', configuration(stable)));
  releaseLocalLock(lock); return { root, store, state };
}
function cleanup(c) {
  const root = fs.realpathSync(c.root); assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
  fs.rmSync(root, { recursive: true, force: true });
}
function commit(c, n) {
  const lock = acquireLocalLock(c.root), configLock = acquireLocalConfigLock(c.root);
  try {
    const stable = c.store.read(lock).stable;
    const candidate = { kind: 'nextjs', container: `next-${n}`, port: stable.port === 3101 ? 3102 : 3101, image: `${IMAGE}sha256:${(n + 10).toString(16).repeat(64)}` };
    let s = c.state.phase === 'preparing' ? c.store.read(lock) : c.store.consume(lock, c.state.revision, `used-${200 + n}-a1`);
    assert.equal(s.activeReleaseId, `used-${200 + n}-a1`);
    s = c.store.saveCandidateConfiguration(lock, s.revision, candidate, candidatePlan(stable, candidate, n).configurationReceipt);
    for (const phase of ['candidate_starting', 'candidate_checking', 'candidate_ready']) s = c.store.checkpoint(lock, s.revision, phase, candidate);
    const text = configText(stable.port);
    let plan = createNginxPlan({ stable, candidate, origin: ORIGIN, config: { path: '/etc/nginx/conf.d/siteflow.conf', realPath: '/etc/nginx/conf.d/siteflow.conf', uid: 0, mode: 0o600,
      symlink: false, links: 1, text, reviewedHash: hash(text), parentEntries: pathChain('/etc/nginx/conf.d').map(p => ({ path: p, realPath: p, type: 'directory', uid: 0, gid: 0, mode: 0o755, symlink: false, deviceId: 1 })) },
      observed: { currentUpstreamPort: stable.port, stable: healthy(stable), candidate: healthy(candidate), configurationExclusive: true, nginxHealthy: true } });
    const receipt = c.store.prepareNginxRecovery(lock, configLock, s.revision, plan, Buffer.from(text));
    for (const type of ['backup_saved', 'staged_validated', 'intent_saved', 'config_installed', 'config_validated', 'reloaded', 'public_checked', 'committed']) {
      plan = advanceNginxPlan(plan, { type, success: true, observation: type === 'public_checked' ? healthy(candidate) : null }, receipt);
    }
    c.state = c.store.read(lock);
  } finally { releaseLocalLock(configLock); releaseLocalLock(lock); }
}

function integrationHarness() {
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


return {setup,prepare,observer,run,cleanup};
}

let base;
test.before(() => { base = setup(); commit(base, 1); commit(base, 2); });
test.after(() => cleanup(base));
function cloneBase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-'));
  fs.cpSync(base.root, root, { recursive: true });
  return { root, state: structuredClone(base.state), store: createLocalStateStore(root, { now: () => NOW }) };
}
function local(name, run) { test(name, async () => { const c = cloneBase(); try { await run(c); } finally { cleanup(c); } }); }
function reserve(c) {
  c.lock = acquireLocalLock(c.root); c.configLock = acquireLocalConfigLock(c.root);
  c.state = c.store.consume(c.lock, c.state.revision, 'used-203-a1');
}
function release(c) { for (const h of [c.configLock, c.lock]) if (h) { try { releaseLocalLock(h); } catch { /* local incident locks are not reclaimed */ } } c.configLock = c.lock = null; }
function observation(c, stage = 'present') {
  const s = c.state, old = base.state.previous, oldConfig = base.state.previousConfiguration;
  const current = { containerId: '2'.repeat(64), releaseId: s.stableReleaseId, owner: 'poll-release', slot: structuredClone(s.stable),
    configuration: structuredClone(s.stableConfiguration.configuration), running: true, ready: true };
  const target = { containerId: '1'.repeat(64), releaseId: oldConfig.releaseId, owner: 'poll-release', slot: structuredClone(old),
    configuration: structuredClone(oldConfig.configuration), running: stage === 'present', ready: false };
  return { observedAt: NOW, incident: false, containers: stage === 'removed' ? [current] : [current, target],
    listeners: [{ port: current.slot.port, containerId: current.containerId }, ...(stage === 'present' ? [{ port: target.slot.port, containerId: target.containerId }] : [])],
    nginx: { slot: structuredClone(s.stable), configHash: base.state.nginxRecovery.afterHash, healthy: true, configurationExclusive: true },
    resources: { availableMemoryBytes: GiB, rootFreeBytes: 8 * GiB, imageUnpackedBytes: GiB / 2, mysqlHealthy: true } };
}
function prepareCleanup(c, edit = () => {}) {
  reserve(c); const o = observation(c); edit(o);
  c.receipt = c.store.prepareGenerationCleanup(c.lock, c.configLock, c.state.revision, 'used-201-a1', o); return o;
}
function finish(c) {
  c.store.advanceGenerationCleanup(c.receipt, 'stopped', observation(c, 'stopped'));
  c.store.checkGenerationCleanup(c.receipt, observation(c, 'stopped'));
  return c.store.advanceGenerationCleanup(c.receipt, 'removed', observation(c, 'removed'));
}
function requestStop(c) { return openLocalStopRequester(c.root, c.state.workspaceId, { now: () => NOW }).requestStop(); }

local('M4: current committed rollback cannot be retired before next release reservation', c => {
  c.lock = acquireLocalLock(c.root); c.configLock = acquireLocalConfigLock(c.root);
  assert.throws(() => c.store.prepareGenerationCleanup(c.lock, c.configLock, c.state.revision, 'used-201-a1', observation(c)), /PHASE/);
  release(c);
});
local('M4: retirement intent binds exact IDs, saved config and newly recorded rollback before plans', c => {
  const o = prepareCleanup(c); const p = c.store.checkGenerationCleanup(c.receipt, o);
  assert.equal(p.executionAllowed, false); assert.deepEqual(p.operation.args, ['stop', '1'.repeat(64)]);
  const record = JSON.parse(fs.readFileSync(path.join(c.root, 'generation-cleanup.json'))).payload;
  assert.equal(record.releaseId, 'used-203-a1'); assert.equal(record.rollback.releaseId, 'used-202-a1');
  assert.equal(record.rollback.slot.port, 3102); assert.equal(record.target.releaseId, 'used-201-a1');
  assert.deepEqual(record.target.configuration, base.state.previousConfiguration);
  assert.throws(() => c.store.read(c.lock), /CLEANUP_INCOMPLETE/); release(c);
});
local('M4: stop confirmation is not deletion confirmation; completion alone frees the slot', c => {
  prepareCleanup(c);
  assert.throws(() => c.store.checkGenerationCleanup({}, observation(c)), /REJECTED/);
  const stopped = c.store.advanceGenerationCleanup(c.receipt, 'stopped', observation(c, 'stopped'));
  assert.equal(stopped.slotAvailable, false);
  const p = c.store.checkGenerationCleanup(c.receipt, observation(c, 'stopped'));
  assert.deepEqual(p.operation.args, ['rm', '1'.repeat(64)]); assert.equal(p.operation.args.length, 2);
  const result = c.store.advanceGenerationCleanup(c.receipt, 'removed', observation(c, 'removed'));
  assert.equal(result.slotAvailable, true); assert.equal(result.executionAllowed, false);
  assert.deepEqual(c.store.read(c.lock).stable, base.state.stable);
  assert.deepEqual(c.store.read(c.lock).previous, base.state.stable);
  assert.throws(() => c.store.advanceGenerationCleanup(c.receipt, 'removed', observation(c, 'removed')), /RECEIPT/);
  release(c);
});
local('M4: 3001 -> 3101 -> 3102 -> reclaimed 3101 preserves latest stable as rollback', c => {
  assert.equal(base.state.previous.port, 3101); assert.equal(base.state.stable.port, 3102);
  prepareCleanup(c); finish(c); c.state = c.store.read(c.lock); release(c);
  commit(c, 3);
  assert.equal(c.state.stable.port, 3101); assert.equal(c.state.previous.port, 3102);
  assert.equal(c.state.nginxRecovery.previousReleaseId, 'used-202-a1');
  assert.deepEqual(c.state.consumedIds, ['used-201-a1', 'used-202-a1', 'used-203-a1']);
  assert.ok(fs.existsSync(path.join(c.root, 'generation-done-used-201-a1.json')));
});
for (const id of ['used-202-a1', 'used-203-a1', 'used-999-a1', 'manual-initial-reviewed', '../state.json']) local(`M4: protected or unknown release ${id} is never a cleanup target`, c => {
  reserve(c); assert.throws(() => c.store.prepareGenerationCleanup(c.lock, c.configLock, c.state.revision, id, observation(c))); release(c);
});
for (const [name, edit] of [
  ['unknown owner', o => { o.containers[1].owner = 'unmanaged'; }],
  ['wrong generation', o => { o.containers[1].releaseId = 'used-999-a1'; }],
  ['wrong digest', o => { o.containers[1].slot.image = `${IMAGE}sha256:${'e'.repeat(64)}`; }],
  ['wrong configuration', o => { o.containers[1].configuration.env.SITEFLOW_DB_NAME = 'other'; }],
  ['bad container ID', o => { o.containers[1].containerId = 'not-an-id'; }],
  ['target is Vinext', o => { o.containers[1].slot.port = 3002; }],
  ['Nginx references target', o => { o.nginx.slot = o.containers[1].slot; }],
  ['Nginx hash unknown', o => { o.nginx.configHash = 'e'.repeat(64); }],
  ['no writer exclusion', o => { o.nginx.configurationExclusive = false; }],
  ['stable unhealthy', o => { o.containers[0].ready = false; }],
  ['stable config mismatch', o => { o.containers[0].configuration.privileged = true; }],
  ['memory shortage', o => { o.resources.availableMemoryBytes = 767 * 1024 ** 2; }],
  ['disk shortage', o => { o.resources.rootFreeBytes = GiB; }],
  ['MySQL not healthy', o => { o.resources.mysqlHealthy = false; }],
  ['stale observation', o => { o.observedAt = NOW - 6; }],
  ['incident observation', o => { o.incident = true; }],
]) local(`M4: refuses ${name} before intent`, c => {
  reserve(c); const o = observation(c); edit(o);
  assert.throws(() => c.store.prepareGenerationCleanup(c.lock, c.configLock, c.state.revision, 'used-201-a1', o));
  assert.equal(fs.existsSync(path.join(c.root, 'generation-cleanup.json')), false); release(c);
});
for (const stage of ['before_prepare', 'before_stop', 'before_remove', 'before_confirm']) local(`M4: latest durable stop at ${stage} prevents cleanup progress`, c => {
  if (stage === 'before_prepare') {
    reserve(c); requestStop(c); assert.throws(() => c.store.prepareGenerationCleanup(c.lock, c.configLock, c.state.revision, 'used-201-a1', observation(c)));
  } else {
    prepareCleanup(c);
    if (stage !== 'before_stop') c.store.advanceGenerationCleanup(c.receipt, 'stopped', observation(c, 'stopped'));
    requestStop(c);
    if (stage === 'before_confirm') assert.throws(() => c.store.advanceGenerationCleanup(c.receipt, 'removed', observation(c, 'removed')));
    else assert.throws(() => c.store.checkGenerationCleanup(c.receipt, observation(c, stage === 'before_stop' ? 'present' : 'stopped')));
    assert.equal(inspectLocalState(c.root).status, 'incident');
  }
  assert.equal(openLocalStopReader(c.root, c.state.workspaceId).read().status, 'requested'); release(c);
});
for (const [name, edit] of [
  ['replacement ID', o => { o.containers[1].containerId = '3'.repeat(64); o.listeners = o.listeners.filter(l => l.port === 3102); }],
  ['replacement rollback', o => { o.containers[0].containerId = '3'.repeat(64); o.listeners[0].containerId = '3'.repeat(64); }],
  ['changed owner', o => { o.containers[1].owner = 'other'; }],
  ['changed Nginx', o => { o.nginx.slot = o.containers[1].slot; }],
]) local(`M4: ${name} immediately before remove latches incident`, c => {
  prepareCleanup(c); c.store.advanceGenerationCleanup(c.receipt, 'stopped', observation(c, 'stopped'));
  const o = observation(c, 'stopped'); edit(o); assert.throws(() => c.store.checkGenerationCleanup(c.receipt, o));
  assert.equal(inspectLocalState(c.root).status, 'incident'); release(c);
});
local('M4: unconfirmed stop does not permit remove', c => {
  prepareCleanup(c); assert.throws(() => c.store.advanceGenerationCleanup(c.receipt, 'stopped', observation(c)));
  assert.equal(inspectLocalState(c.root).status, 'incident'); release(c);
});
local('M4: present/replaced container is not accepted as successful removal', c => {
  prepareCleanup(c); c.store.advanceGenerationCleanup(c.receipt, 'stopped', observation(c, 'stopped'));
  assert.throws(() => c.store.advanceGenerationCleanup(c.receipt, 'removed', observation(c, 'stopped')));
  assert.equal(inspectLocalState(c.root).status, 'incident'); release(c);
});
local('M4: reboot with incomplete cleanup blocks automatic deployment and has no receipt resume', c => {
  prepareCleanup(c); release(c); assert.equal(inspectLocalState(c.root).status, 'incident');
  c.lock = acquireLocalLock(c.root); const reopened = createLocalStateStore(c.root, { now: () => NOW });
  assert.throws(() => reopened.read(c.lock), /CLEANUP/);
  assert.throws(() => reopened.advanceGenerationCleanup(c.receipt, 'removed', observation(c, 'removed')), /RECEIPT/); release(c);
});
for (const phase of ['before_intent', 'after_write', 'before_confirmation', 'before_rename']) local(`M4: simulated failure ${phase} preserves uncertain cleanup and blocks new work`, c => {
  reserve(c); c.store = createLocalStateStore(c.root, { now: () => NOW, fault: p => { if (p === `cleanup_${phase}`) throw new Error('SIMULATED_IO_FAILURE'); } });
  assert.throws(() => {
    c.receipt = c.store.prepareGenerationCleanup(c.lock, c.configLock, c.state.revision, 'used-201-a1', observation(c));
    c.store.advanceGenerationCleanup(c.receipt, 'stopped', observation(c, 'stopped'));
  });
  assert.equal(inspectLocalState(c.root).status, 'incident'); release(c);
});
local('M4: generation source is historical committed state, not caller supplied verified data', c => {
  reserve(c); const source = structuredClone(base.state.previousConfiguration);
  assert.equal(source.releaseId, 'used-201-a1');
  assert.throws(() => validateCleanupRecord({ verified: true, target: source }));
  const record = { releaseId: source.releaseId, slot: source.slot, configuration: source };
  assert.throws(() => createGenerationCleanup({ ...c.state, phase: 'incident' }, record, record, observation(c), 'a'.repeat(64), NOW)); release(c);
});

const harness = integrationHarness();
let integratedBase;
test.before(async () => {
  integratedBase = harness.setup(true);
  for (const ordinal of [1, 2]) {
    const result = await harness.run(integratedBase, await harness.prepare(integratedBase, ordinal));
    assert.equal(result.status, 'mock_committed'); integratedBase.state = result.state;
  }
});
test.after(() => harness.cleanup(integratedBase));
for (const scenario of ['success', 'candidate_failure', 'stop_before_switch', 'unknown_owner', 'unconfirmed_removal']) {
  test(`M4 integration: third update with retained slot, ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-'));
    fs.cpSync(integratedBase.root, root, { recursive: true });
    const c = { root, state: structuredClone(integratedBase.state), store: createLocalStateStore(root, { now: () => NOW }) };
    const retired = { containerId: '1'.repeat(64), releaseId: c.state.previousConfiguration.releaseId, owner: 'poll-release',
      slot: c.state.previous, configuration: c.state.previousConfiguration.configuration, running: true, ready: false };
    let removed = false;
    try {
      const prepared = await harness.prepare(c, 3);
      const result = await harness.run(c, prepared, (stage, data, state) => {
        if (stage === 'before_create' && !removed) {
          data.docker.runtime.containers.push(healthy(retired.slot));
          data.docker.runtime.listeners.push({ port: retired.slot.port, container: retired.slot.container });
        }
        if (stage.startsWith('generation_cleanup_')) {
          const target = structuredClone(retired);
          if (stage !== 'generation_cleanup_before_stop') target.running = false;
          if (scenario === 'unknown_owner') target.owner = 'unmanaged';
          removed = stage === 'generation_cleanup_removed' && scenario !== 'unconfirmed_removal';
          const stable = { containerId: '2'.repeat(64), releaseId: state.stableReleaseId, owner: 'poll-release', slot: state.stable,
            configuration: state.stableConfiguration.configuration, running: true, ready: true };
          data.generations = { observedAt: NOW, incident: false, containers: [stable, ...(!removed ? [target] : [])],
            listeners: [{ port: stable.slot.port, containerId: stable.containerId }, ...(target.running && !removed ? [{ port: target.slot.port, containerId: target.containerId }] : [])],
            nginx: { slot: state.stable, configHash: hash(configText(state.stable.port)), healthy: true, configurationExclusive: true },
            resources: { availableMemoryBytes: GiB, rootFreeBytes: 8 * GiB, imageUnpackedBytes: GiB / 2, mysqlHealthy: true } };
        }
        if (scenario === 'candidate_failure' && stage === 'candidate_starting') data.event.success = false;
        if (scenario === 'stop_before_switch' && stage === 'before_switch') openLocalStopRequester(root, state.workspaceId, { now: () => NOW }).requestStop();
      });
      assert.equal(result.executionAllowed, false);
      if (scenario === 'success') {
        assert.equal(result.status, 'mock_committed');
        assert.equal(result.state.stable.port, 3101); assert.equal(result.state.previous.port, 3102);
        assert.equal(result.state.nginxRecovery.previousReleaseId, 'used-102-a1');
        assert.ok(result.trace.some(x => x.stage === 'generation_cleanup_confirmed'));
        assert.deepEqual(result.state.consumedIds, ['used-101-a1', 'used-102-a1', 'used-103-a1']);
      } else {
        assert.equal(result.status, 'rejected');
        const persisted = inspectLocalState(root);
        if (['candidate_failure', 'unknown_owner'].includes(scenario)) {
          assert.equal(persisted.status, 'snapshot'); assert.equal(persisted.state.phase, 'incident');
        } else assert.equal(persisted.status, 'incident');
        assert.deepEqual(result.state.stable, c.state.stable);
        assert.equal(result.state.previous.port, 3102);
      }
    } finally { harness.cleanup(c); }
  });
}
