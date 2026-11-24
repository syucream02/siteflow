import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runMockBootRecovery, assessBootGenerations } from '../deploy/poll/boot-recovery.mjs';
import { createLocalStateStore, inspectLocalState } from '../deploy/poll/persistent-state.mjs';
import { acquireLocalLock, acquireLocalConfigLock, releaseLocalLock } from '../deploy/poll/lock.mjs';
import { openLocalStopRequester, openLocalStopReader } from '../deploy/poll/stop-control.mjs';
import { createNginxPlan, advanceNginxPlan, readinessRequest } from '../deploy/poll/nginx-plan.mjs';
import { pathChain } from '../deploy/poll/linux-storage.mjs';
import { createBootstrapContainerConfiguration, createDockerPlan } from '../deploy/poll/docker-plan.mjs';

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
function local(name, run) { test(name, async () => { const c = setup(); try { await run(c); } finally { cleanup(c); } }); }
function commit(c, n) {
  const lock = acquireLocalLock(c.root), configLock = acquireLocalConfigLock(c.root);
  try {
    const stable = c.store.read(lock).stable;
    const candidate = { kind: 'nextjs', container: `next-${n}`, port: stable.port === 3101 ? 3102 : 3101, image: `${IMAGE}sha256:${(n + 10).toString(16).repeat(64)}` };
    let s = c.store.consume(lock, c.state.revision, `used-${200 + n}-a1`);
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
function fixture(c, running = false) {
  const s = c.state, f = storage(), id = '1'.repeat(64), imageId = `sha256:${'f'.repeat(64)}`;
  return {
    storage: { observedAt: NOW, observation: f.observation },
    mysql: { observedAt: NOW, ready: true, tls: true, dataUuid: f.policy.uuid },
    image: { observedAt: NOW, releaseId: s.stableReleaseId, repoDigests: [s.stable.image], imageId, os: 'linux', architecture: 'amd64' },
    container: { observedAt: NOW, containers: [{ id, name: s.stable.container, port: s.stable.port, image: s.stable.image, imageId, running, ready: running, command: ['node', 'server.js'], configuration: structuredClone(s.stableConfiguration.configuration) }],
      listeners: running ? [{ port: s.stable.port, containerId: id }] : [], availableMemoryBytes: GiB, rootFreeBytes: 8 * GiB },
    services: { observedAt: NOW, legacy3001Enabled: false, legacy3001Active: false, otherBootWorkerActive: false, pollWorkerActive: false, dockerReady: true },
    start_result: { observedAt: NOW, containerId: id, success: true },
    app_readiness: { observedAt: NOW, containerId: id, slot: s.stable, running: true, ready: true, request: readinessRequest(ORIGIN, s.stable.port) },
    nginx: { observedAt: NOW, route: s.stable, configHash: s.nginxRecovery?.afterHash ?? hash(configText(s.stable.port)), configMatches: true,
      configurationExclusive: true, nginxHealthy: true, backupHash: s.nginxRecovery?.beforeHash ?? null, backupFile: s.nginxRecovery?.backupFile ?? null },
    public_health: { observedAt: NOW, containerId: id, slot: s.stable, httpStatus: 200, ok: true, consecutive: 3, freshConnections: true, workerGenerationConfirmed: true },
  };
}
function run(c, f = fixture(c), hook = () => {}) {
  return runMockBootRecovery({ directory: c.root, storagePolicy: storage().policy, origin: ORIGIN, now: () => NOW,
    observe: async (stage, state) => { await hook(stage, state); return f[stage]; } });
}
function stop(c) { return openLocalStopRequester(c.root, c.state.workspaceId, { now: () => NOW }).requestStop(); }
function rewrite(c, edit) {
  const p = path.join(c.root, 'state.json'), e = JSON.parse(fs.readFileSync(p)); edit(e.payload);
  e.checksumSha256 = hash(JSON.stringify(e.payload)); const text = JSON.stringify(e);
  fs.writeFileSync(p, text); fs.writeFileSync(path.join(c.root, `revision-${String(e.payload.revision).padStart(10, '0')}.json`), text); c.state = e.payload;
}

local('H4: initial 3001 with persisted OCI binding restores fixed existing container only', async c => {
  const before = structuredClone(c.state), r = await run(c);
  assert.equal(r.status, 'mock_stable_restored'); assert.equal(r.executionAllowed, false); assert.equal(r.newDeploymentAllowed, false);
  assert.equal(r.operations.length, 1); assert.deepEqual(r.operations[0].args, ['start', '1'.repeat(64)]);
  assert.deepEqual(r.state, before); assert.deepEqual(inspectLocalState(c.root).state, before);
  assert.deepEqual(r.trace, ['storage', 'state_and_stop', 'mysql', 'image', 'container', 'services', 'start_result', 'app_readiness', 'nginx', 'public_health', 'stable_confirmed']);
  assert.doesNotMatch(JSON.stringify(r.operations), /pull|create|latest|migration|nginx|systemctl|remove/);
});
for (const n of [1, 2, 3]) local(`H4: reboot after ${n} committed updates keeps saved stable and rollback`, async c => {
  for (let i = 1; i <= n; i++) commit(c, i);
  const before = structuredClone(c.state), r = await run(c);
  assert.equal(r.status, 'mock_stable_restored'); assert.equal(r.state.stable.port, n === 2 ? 3102 : 3101);
  assert.deepEqual(r.generations.rollback, before.previous); assert.deepEqual(r.state.consumedIds, before.consumedIds);
  assert.deepEqual(inspectLocalState(c.root).state, before);
});
local('H4: existing running stable is checked without planning a second start', async c => {
  const r = await run(c, fixture(c, true)); assert.equal(r.status, 'mock_stable_checked'); assert.deepEqual(r.operations, []);
});
for (const [name, edit] of [
  ['local image ID is not OCI binding', s => { s.stable.image = `sha256:${'a'.repeat(64)}`; s.lastKnownGood = s.stable; }],
  ['missing release ID', s => { s.stableReleaseId = null; }], ['unknown release ID', s => { s.stableReleaseId = 'latest'; }],
  ['Vinext port', s => { s.stable.port = 3002; s.lastKnownGood = s.stable; }], ['unknown port', s => { s.stable.port = 9999; s.lastKnownGood = s.stable; }],
  ['unknown digest', s => { s.stable.image = `${IMAGE}latest`; s.lastKnownGood = s.stable; }],
  ['initial wrong blue slot', s => { s.stable.port = 3101; s.lastKnownGood = s.stable; }],
]) local(`H4: rejects saved ${name}`, async c => {
  const f = fixture(c); rewrite(c, edit); const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
local('H4: corrupt durable state does not fall back to main/latest or bootstrap', async c => {
  fs.writeFileSync(path.join(c.root, 'state.json'), '{broken'); const r = await run(c);
  assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []); assert.equal(fs.readFileSync(path.join(c.root, 'state.json'), 'utf8'), '{broken');
});
for (const [name, edit] of [
  ['unmounted EBS', f => { f.storage.observation.mount.mounted = false; }], ['wrong EBS', f => { f.storage.observation.mount.volumeId = 'vol-22222222222222222'; }],
  ['wrong UUID', f => { f.storage.observation.mount.uuid = '22222222-2222-3333-4444-555555555555'; }], ['MySQL not ready', f => { f.mysql.ready = false; }],
  ['wrong MySQL data EBS', f => { f.mysql.dataUuid = 'wrong'; }], ['MySQL TLS missing', f => { f.mysql.tls = false; }],
  ['OCI mismatch', f => { f.image.repoDigests = [`${IMAGE}sha256:${'b'.repeat(64)}`]; }], ['release mismatch', f => { f.image.releaseId = 'manual-other'; }],
  ['local image mapping mismatch', f => { f.container.containers[0].imageId = `sha256:${'e'.repeat(64)}`; }],
  ['saved container missing', f => { f.container.containers = []; }], ['container image mismatch', f => { f.container.containers[0].image = `${IMAGE}sha256:${'e'.repeat(64)}`; }],
  ['memory shortage', f => { f.container.availableMemoryBytes = 767 * 1024 ** 2; }], ['disk shortage', f => { f.container.rootFreeBytes = 1024; }],
  ['legacy service enabled', f => { f.services.legacy3001Enabled = true; }], ['legacy service active', f => { f.services.legacy3001Active = true; }],
  ['duplicate boot service', f => { f.services.otherBootWorkerActive = true; }], ['polling active', f => { f.services.pollWorkerActive = true; }],
  ['Docker unavailable', f => { f.services.dockerReady = false; }], ['migration command', f => { f.container.containers[0].command = ['node', 'deploy/migrate.mjs']; }],
]) local(`H4: rejects ${name} before start plan`, async c => {
  const f = fixture(c); edit(f); const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
for (const [name, edit] of [
  ['start outcome unknown', f => { f.start_result.success = false; }], ['wrong start container', f => { f.start_result.containerId = '2'.repeat(64); }],
  ['app readiness false', f => { f.app_readiness.ready = false; }], ['wrong Host/proto request', f => { f.app_readiness.request.headers.Host = 'other.invalid'; }],
  ['Nginx wrong route', f => { f.nginx.route = { ...f.nginx.route, port: 3002 }; }], ['Nginx unhealthy', f => { f.nginx.nginxHealthy = false; }],
  ['Certbot/writer lock unknown', f => { f.nginx.configurationExclusive = false; }], ['public health 503', f => { f.public_health.httpStatus = 503; }],
  ['public health wrong container', f => { f.public_health.containerId = '2'.repeat(64); }], ['public health insufficient successes', f => { f.public_health.consecutive = 2; }],
]) local(`H4: ${name} preserves incident across next invocation`, async c => {
  const f = fixture(c); edit(f); const r = await run(c, f); assert.equal(r.status, 'incident');
  assert.equal(inspectLocalState(c.root).status, 'incident'); const retry = await run(c); assert.equal(retry.status, 'incident'); assert.deepEqual(retry.operations, []);
});
local('H4: stop request blocks stopped stable, so site may remain down after reboot', async c => {
  stop(c); const r = await run(c); assert.equal(r.status, 'blocked_by_stop'); assert.equal(r.reason, 'STOP_BLOCKS_RESTART_SITE_MAY_REMAIN_DOWN');
  assert.deepEqual(r.operations, []); assert.equal(openLocalStopReader(c.root, c.state.workspaceId).read().status, 'requested');
  assert.equal((await run(c)).status, 'blocked_by_stop'); assert.equal(fs.existsSync(path.join(c.root, 'incident.json')), false);
});
local('H4: stop request allows read-only checks of already running stable, never new deploy', async c => {
  stop(c); const r = await run(c, fixture(c, true)); assert.equal(r.status, 'mock_stable_checked'); assert.equal(r.stopRequested, true);
  assert.deepEqual(r.operations, []); assert.equal(r.newDeploymentAllowed, false);
});
local('H4: unknown stop record refuses even running stable verification', async c => {
  const req = stop(c); fs.writeFileSync(path.join(c.root, `stop-request-${req.requestId}.json`), '{broken');
  const r = await run(c, fixture(c, true)); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
local('H4: existing incident persists without auto reset', async c => {
  fs.writeFileSync(path.join(c.root, 'incident.json'), JSON.stringify({ reason: 'EXISTING_INCIDENT' }));
  const before = fs.readFileSync(path.join(c.root, 'incident.json'), 'utf8'); const r = await run(c);
  assert.equal(r.status, 'incident'); assert.equal(fs.readFileSync(path.join(c.root, 'incident.json'), 'utf8'), before);
});
local('H4: in-progress deployment does not select previous or candidate as newly committed stable', async c => {
  const lock = acquireLocalLock(c.root); c.state = c.store.consume(lock, 0, 'used-999-a1'); releaseLocalLock(lock);
  assert.equal((await run(c)).status, 'incident');
});
for (const name of ['duplicate stable port', 'duplicate stable digest', 'duplicate container name', 'stable port listener conflict']) local(`H4: ${name} is rejected without stopping another container`, async c => {
  const f = fixture(c), other = { ...f.container.containers[0], id: '2'.repeat(64), name: 'other', port: 3101, image: `${IMAGE}sha256:${'b'.repeat(64)}` };
  if (name === 'duplicate stable port') other.port = 3001;
  if (name === 'duplicate stable digest') other.image = c.state.stable.image;
  if (name === 'duplicate container name') other.name = c.state.stable.container;
  f.container.containers.push(other);
  if (name === 'stable port listener conflict') f.container.listeners.push({ port: 3001, containerId: other.id });
  const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
for (const n of [1, 2, 3]) local(`H4: retained rollback occupies next slot after update ${n}; requires separate cleanup approval`, async c => {
  for (let i = 1; i <= n; i++) commit(c, i);
  const f = fixture(c), previous = c.state.previous;
  // 初回previous3001は別枠。次の3102を旧世代が占有する例も検証。
  const nextPort = c.state.stable.port === 3101 ? 3102 : 3101;
  f.container.containers.push({ id: '2'.repeat(64), name: previous.port === 3001 ? 'retained-green' : previous.container, port: nextPort,
    image: previous.image, imageId: `sha256:${'e'.repeat(64)}`, running: false, ready: false, command: ['node', 'server.js'], configuration: configuration(previous) });
  const r = await run(c, f); assert.equal(r.status, 'mock_stable_restored');
  assert.equal(r.generations.nextSlot.status, 'requires_generation_cleanup_approval'); assert.deepEqual(r.generations.rollback, previous);
  assert.equal(r.generations.cleanupImplemented, false); assert.equal(r.operations.length, 1);
});
local('H4/H2: mismatched committed Nginx hash or missing backup refuses recovery', async c => {
  commit(c, 1); const f = fixture(c); f.nginx.configHash = 'e'.repeat(64);
  const r = await run(c, f); assert.equal(r.status, 'incident');
});
local('H4/H2: damaged durable backup refuses boot before container plan', async c => {
  commit(c, 1); fs.writeFileSync(path.join(c.root, c.state.nginxRecovery.backupFile), '{}');
  const r = await run(c); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
for (const stage of ['mysql', 'image', 'container', 'services']) local(`H4/H3: latest stop at ${stage} prevents stopped-container start`, async c => {
  const r = await run(c, fixture(c), s => { if (s === stage) stop(c); }); assert.equal(r.status, 'blocked_by_stop'); assert.deepEqual(r.operations, []);
});
local('H4/H3: stop after start outcome becomes incident, not silently cleared', async c => {
  const r = await run(c, fixture(c), s => { if (s === 'start_result') stop(c); }); assert.equal(r.status, 'incident');
  assert.equal(openLocalStopReader(c.root, c.state.workspaceId).read().status, 'requested');
});
local('H4: simulated abrupt exit during start persists uncertainty for next boot', async c => {
  const r = await run(c, fixture(c), s => { if (s === 'start_result') throw new Error('SIMULATED_EXIT'); }); assert.equal(r.status, 'incident');
  assert.equal((await run(c)).status, 'incident');
});
local('H4: lock conflict refuses before boot start', async c => {
  const lock = acquireLocalLock(c.root);
  try { const r = await run(c); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []); }
  finally { releaseLocalLock(lock); }
});
local('H4: fresh state read detects asynchronous modification', async c => {
  const r = await run(c, fixture(c), s => { if (s === 'image') rewrite(c, state => { state.stableReleaseId = 'manual-other'; }); });
  assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
local('H4: stale/unknown observations never permit boot', async c => {
  const f = fixture(c); f.image.observedAt = NOW - 6; const r = await run(c, f); assert.equal(r.status, 'incident');
});
test('H4: no network, process execution, tag lookup, migration or authorized entrance', () => {
  const source = fs.readFileSync(new URL('../deploy/poll/boot-recovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(https|http|net|child_process)|fetch\s*\(|executionAllowed:\s*true/);
  assert.ok(source.includes("args: ['start', container.id]"));
  assert.equal(typeof assessBootGenerations, 'function');
});
for (const [label, thrown] of [['null', null], ['message getter', { get message() { throw new Error('DO_NOT_READ_EXCEPTION_CONTENT'); } }]]) local(`H4: ${label} exception cannot bypass persistent incident`, async c => {
  const r = await run(c, fixture(c), s => { if (s === 'start_result') throw thrown; });
  assert.equal(r.status, 'incident'); assert.equal(inspectLocalState(c.root).status, 'incident');
});
local('H4: legacy state remains readable but is not automatically used for boot', async c => {
  const f = fixture(c);
  rewrite(c, s => { s.schemaVersion = 1; delete s.stableReleaseId; delete s.nginxRecovery; delete s.stableConfiguration; delete s.previousConfiguration; delete s.candidateConfiguration; });
  const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
  const stored = JSON.parse(fs.readFileSync(path.join(c.root, 'state.json'))); assert.equal(stored.payload.schemaVersion, 1);
});
local('H4: missing committed release identity rejects, never falls back to initial 3001', async c => {
  commit(c, 1); const f = fixture(c); rewrite(c, s => { s.stableReleaseId = 'used-999-a1'; });
  const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
local('fix4: boot failure creates structured incident and mock notice without restoration', async c => {
  const f = fixture(c); f.mysql.ready = false;
  const r = await run(c, f);
  assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
  assert.equal(r.incident.status, 'recorded'); assert.equal(r.incident.notification.status, 'planned');
  const lock = acquireLocalLock(c.root);
  try { assert.equal(c.store.listIncidents(lock)[0].stage, 'boot'); } finally { releaseLocalLock(lock); }
});
local('fix4: boot corrupt initial state is preserved and described as unknown', async c => {
  const f = fixture(c), file = path.join(c.root, 'state.json'); fs.writeFileSync(file, '{broken-state');
  const r = await run(c, f);
  assert.equal(r.status, 'incident'); assert.equal(r.incident.status, 'recorded');
  assert.equal(r.incident.notification.status, 'planned'); assert.deepEqual(r.operations, []);
  const lock = acquireLocalLock(c.root);
  try {
    const saved = c.store.listIncidents(lock)[0];
    assert.equal(saved.phase, 'unknown'); assert.equal(saved.stateConfidence, 'unconfirmed'); assert.equal(saved.stable, null);
  } finally { releaseLocalLock(lock); }
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken-state');
});
local('H4: next-slot port occupied only by listener requires cleanup approval', async c => {
  const f = fixture(c); f.container.listeners.push({ port: 3101, containerId: '2'.repeat(64) });
  const r = await run(c, f); assert.equal(r.status, 'mock_stable_restored');
  assert.equal(r.generations.nextSlot.status, 'requires_generation_cleanup_approval');
});
for (const [name, change] of [
  ['Entrypoint migration despite harmless command', c => { c.entrypoint = ['node', 'deploy/migrate.mjs']; }],
  ['Cmd migration despite harmless command', c => { c.cmd = ['deploy/migrate.mjs']; }],
  ['root user', c => { c.user = '0:0'; }], ['working directory', c => { c.workingDir = '/tmp'; }],
  ['extra MySQL mount', c => { c.mounts.push({ type: 'bind', source: '/srv/siteflow-mysql/data', target: '/var/lib/mysql', readOnly: false }); }],
  ['mount writable', c => { c.mounts[0].readOnly = false; }], ['mount source changed', c => { c.mounts[0].source = '/srv/siteflow-mysql/secrets/other-password'; }],
  ['mount target changed', c => { c.mounts[0].target = '/tmp/password'; }], ['mount type', c => { c.mounts[0].type = 'volume'; }],
  ['host-wide port exposure', c => { c.portBindings[0].hostIp = '0.0.0.0'; }], ['wrong port', c => { c.portBindings[0].hostPort = 3002; }],
  ['network', c => { c.networkMode = 'host'; }], ['privileged', c => { c.privileged = true; }], ['writable root', c => { c.readonlyRootfs = false; }],
  ['cap add', c => { c.capAdd = ['SYS_ADMIN']; }], ['cap drop missing', c => { c.capDrop = []; }], ['security option', c => { c.securityOpt = []; }],
  ['memory', c => { c.memory = 0; }], ['swap', c => { c.memorySwap = -1; }], ['CPU', c => { c.nanoCpus = 0; }], ['PID limit', c => { c.pidsLimit = 0; }],
  ['core dump', c => { c.ulimits.core.hard = -1; }], ['tmpfs', c => { c.tmpfs['/tmp'] = 'rw'; }], ['restart', c => { c.restartPolicy = 'always'; }],
  ['Docker log', c => { c.logDriver = 'json-file'; }], ['stop timeout', c => { c.stopTimeout = 0; }],
  ['DB name', c => { c.env.SITEFLOW_DB_NAME = 'restore_db'; }], ['DB user safe but different', c => { c.env.SITEFLOW_DB_USER = 'other_app'; }],
  ['DB TLS', c => { c.env.SITEFLOW_DB_TLS = 'false'; }], ['secret value instead of file', c => { c.env.SITEFLOW_DB_PASSWORD = 'DUMMY_SECRET_SENTINEL'; }],
  ['missing setting', c => { delete c.entrypoint; }], ['unknown verified flag', c => { c.verified = true; }],
]) local(`High2: boot rejects ${name} against saved configuration`, async c => {
  const f = fixture(c); change(f.container.containers[0].configuration);
  const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
  assert.equal(JSON.stringify(r).includes('DUMMY_SECRET_SENTINEL'), false);
});
local('High2: missing saved configuration is never replaced by observed expected values', async c => {
  const f = fixture(c);
  rewrite(c, s => { s.schemaVersion = 2; delete s.stableConfiguration; delete s.previousConfiguration; delete s.candidateConfiguration; });
  const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.root, 'state.json'))).payload.schemaVersion, 2);
});
local('High2: saved configuration cannot be borrowed from a different release or slot', async c => {
  const f = fixture(c); rewrite(c, s => { s.stableConfiguration.releaseId = 'manual-other'; });
  const r = await run(c, f); assert.equal(r.status, 'incident'); assert.deepEqual(r.operations, []);
});
local('High2: caller-created verified object is not accepted as a persisted candidate receipt', async c => {
  const lock = acquireLocalLock(c.root);
  try {
    const s = c.store.consume(lock, 0, 'used-201-a1');
    const candidate = { kind: 'nextjs', container: 'new-candidate', port: 3101, image: `${IMAGE}sha256:${'b'.repeat(64)}` };
    assert.throws(() => c.store.saveCandidateConfiguration(lock, s.revision, candidate, { verified: true }), /ORIGINAL/);
    assert.equal(c.store.read(lock).candidateConfiguration, null); assert.equal(c.store.read(lock).revision, s.revision);
  } finally { releaseLocalLock(lock); }
});
local('High2: in-progress legacy v2 is readable but never silently promoted by configuration save', async c => {
  rewrite(c, s => { s.schemaVersion = 2; delete s.stableConfiguration; delete s.previousConfiguration; delete s.candidateConfiguration; });
  const lock = acquireLocalLock(c.root);
  try {
    const s = c.store.consume(lock, 0, 'used-201-a1');
    const candidate = { kind: 'nextjs', container: 'new-candidate', port: 3101, image: `${IMAGE}sha256:${'b'.repeat(64)}` };
    assert.throws(() => c.store.saveCandidateConfiguration(lock, s.revision, candidate, candidatePlan(s.stable, candidate, 1).configurationReceipt), /EXPLICIT_CONFIGURATION/);
    assert.equal(c.store.read(lock).schemaVersion, 2); assert.equal(c.store.read(lock).activeReleaseId, 'used-201-a1');
  } finally { releaseLocalLock(lock); }
});
