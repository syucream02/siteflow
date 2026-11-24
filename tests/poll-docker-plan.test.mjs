import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerPlan, takeContainerConfiguration, validateSavedContainerConfiguration } from '../deploy/poll/docker-plan.mjs';
import { pathChain } from '../deploy/poll/linux-storage.mjs';

const digest = `sha256:${'b'.repeat(64)}`, sha = 'a'.repeat(40), schema = 'd'.repeat(64), GiB = 1024 ** 3;
function fixture(port = 3001) {
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
test('docker: safe fixed args, 3001 retained, no stop/remove/migration/DB mount', () => {
  const f = fixture(), before = structuredClone(f), p = createDockerPlan(f);
  assert.equal(p.executionAllowed, false); assert.equal(p.previous.port, 3001);
  const args = p.create.args;
  assert.ok(args.includes('127.0.0.1:3101:3000')); assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--memory')); assert.ok(args.includes('384m')); assert.ok(args.includes('--cpus')); assert.ok(args.includes('0.5'));
  assert.ok(args.includes('no-new-privileges:true')); assert.ok(args.includes('core=0'));
  assert.equal(args.includes('--privileged'), false); assert.equal(args.includes('--env'), false);
  assert.equal(JSON.stringify(p).includes('/var/lib/mysql'), false); assert.equal(Object.hasOwn(p, 'execute'), false);
  assert.deepEqual(f, before);
});
for (const port of [3101, 3102]) test(`docker: alternate port from ${port}`, () => { const p = createDockerPlan(fixture(port)); assert.equal(p.candidate.port, port === 3101 ? 3102 : 3101); });
const cases = [
  ['Vinext stable', d => { d.stable.port = 3002; }], ['Vinext candidate', d => { d.candidate.port = 3002; }],
  ['existing candidate', d => { d.runtime.containers.push({ ...d.candidate, running: false }); }],
  ['port occupied', d => { d.runtime.listeners.push({ port: 3101, container: 'other' }); }],
  ['digest mismatch', d => { d.image.repoDigests = [`ghcr.io/syucream02/siteflow@sha256:${'f'.repeat(64)}`]; }],
  ['revision mismatch', d => { d.image.revision = 'f'.repeat(40); }], ['schema mismatch', d => { d.image.schemaHash = 'f'.repeat(64); }],
  ['schema from another image', d => { d.image.schemaSourceDigest = `sha256:${'f'.repeat(64)}`; }],
  ['arbitrary entrypoint', d => { d.image.entrypoint = ['/bin/sh', '-c']; }], ['migration cmd', d => { d.image.cmd = ['node', 'deploy/migrate.mjs']; }],
  ['plaintext password', d => { d.env.SITEFLOW_DB_PASSWORD = 'DUMMY_SECRET_SENTINEL'; }],
  ['incorrect DB', d => { d.env.SITEFLOW_DB_NAME = 'restore_db'; }], ['root DB user', d => { d.policy.databaseUser = 'root'; }],
  ['unencrypted secret path', d => { d.policy.authFile = '/tmp/auth'; d.files.authFile.path = '/tmp/auth'; }],
  ['secret symlink', d => { d.files.authFile.symlink = true; }], ['secret wrong owner', d => { d.files.passwordFile.uid = 0; }],
  ['secret readable by all', d => { d.files.passwordFile.mode = 0o644; }], ['secret wrong UUID', d => { d.files.authFile.uuid = 'wrong'; }],
  ['no memory', d => { d.resources.availableMemoryBytes = 767 * 1024 * 1024; }], ['no disk', d => { d.resources.rootFreeBytes = 100; }],
  ['unknown image size', d => { d.resources.imageUnpackedBytes = null; }], ['mysql unhealthy', d => { d.resources.mysqlHealthy = false; }],
  ['shell injection name', d => { d.candidate.container = 'candidate;rm'; }], ['mount option injection', d => { d.policy.caFile = '/srv/siteflow-mysql/a,b'; }],
  ['DB directory as file', d => { d.policy.authFile = d.storage.policy.mysqlDataDirectory; d.files.authFile.path = d.policy.authFile; d.files.authFile.realPath = d.policy.authFile; }],
  ['CD state directory as file', d => { d.policy.authFile = d.storage.policy.stateDirectory; d.files.authFile.path = d.policy.authFile; d.files.authFile.realPath = d.policy.authFile; }],
  ['arbitrary arguments', d => { d.args = ['--privileged']; }],
];
for (const [name, modify] of cases) test(`docker refuses ${name}`, () => {
  const d = fixture(); modify(d); assert.throws(() => createDockerPlan(d), error => { assert.equal(error.message.includes('DUMMY_SECRET_SENTINEL'), false); return true; });
});
test('High2: configuration receipt is original-bound and one-use, with separate Entrypoint/Cmd', () => {
  const f = fixture(), p = createDockerPlan(f);
  assert.throws(() => takeContainerConfiguration({ ...p.configurationReceipt }, f.candidate, 'used-101-a1'), /ORIGINAL/);
  const saved = takeContainerConfiguration(p.configurationReceipt, f.candidate, 'used-101-a1');
  assert.deepEqual(saved.configuration.entrypoint, ['node']); assert.deepEqual(saved.configuration.cmd, ['server.js']);
  assert.equal(saved.configuration.privileged, false); assert.equal(saved.configuration.memorySwap, 384 * 1024 ** 2);
  assert.throws(() => takeContainerConfiguration(p.configurationReceipt, f.candidate, 'used-101-a1'), /ORIGINAL/);
  assert.throws(() => validateSavedContainerConfiguration({ ...saved, releaseId: 'used-999-a1' }, f.candidate, 'used-101-a1'), /MISMATCH/);
});
