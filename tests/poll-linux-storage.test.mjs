import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLinuxStorage, pathChain, assertLinuxPath } from '../deploy/poll/linux-storage.mjs';

// すべて架空の観測。findmnt/lsblk/AWSに接続しない。
function fixture() {
  const policy = { mount: '/srv/siteflow-mysql', uuid: '11111111-2222-3333-4444-555555555555', volumeId: 'vol-11111111111111111',
    stateDirectory: '/srv/siteflow-mysql/poll-state', mysqlDataDirectory: '/srv/siteflow-mysql/data', minFreeBytes: 256 * 1024 * 1024 };
  const observation = { querySucceeded: true,
    mount: { target: policy.mount, realPath: policy.mount, source: '/dev/nvme1n1', uuid: policy.uuid, volumeId: policy.volumeId, fstype: 'xfs', options: ['rw'], deviceId: 2, mounted: true, encrypted: true },
    entries: pathChain(policy.stateDirectory).map(p => ({ path: p, realPath: p, type: 'directory', uid: 0, gid: 0,
      mode: p === policy.stateDirectory ? 0o700 : 0o755, symlink: false, deviceId: p.startsWith(policy.mount) ? 2 : 1 })),
    mysqlDataRealPath: policy.mysqlDataDirectory, freeBytes: 1024 ** 3, freeInodes: 1000, writeProbeSucceeded: true };
  return { policy, observation };
}
test('storage: complete mock passes but is not Linux proof or execution permission', () => {
  const f = fixture(), before = structuredClone(f), r = assessLinuxStorage(f.policy, f.observation);
  assert.equal(r.status, 'mock_storage_consistent'); assert.equal(r.executionAllowed, false);
  assert.ok(r.pendingChecks.includes('linux_fsync_and_powerloss')); assert.deepEqual(f, before);
});
const cases = [
  ['unmounted', f => { f.observation.mount.mounted = false; }],
  ['wrong UUID', f => { f.observation.mount.uuid = 'wrong'; }],
  ['wrong EBS', f => { f.observation.mount.volumeId = 'vol-22222222222222222'; }],
  ['unencrypted', f => { f.observation.mount.encrypted = false; }],
  ['root filesystem fallback', f => { f.observation.mount.target = '/'; }],
  ['same root device', f => { f.observation.mount.deviceId = 1; f.observation.entries.forEach(e => { e.deviceId = 1; }); }],
  ['wrong filesystem', f => { f.observation.mount.fstype = 'ext4'; }],
  ['readonly', f => { f.observation.mount.options = ['ro']; }],
  ['query failed', f => { f.observation.querySucceeded = false; }],
  ['missing query result', f => { delete f.observation.mount.uuid; }],
  ['not root', f => { f.observation.entries.at(-1).uid = 1000; }],
  ['writable by group', f => { f.observation.entries.at(-1).mode = 0o770; }],
  ['public state directory', f => { f.observation.entries.at(-1).mode = 0o755; }],
  ['symlink ancestor', f => { f.observation.entries[1].symlink = true; }],
  ['realpath differs', f => { f.observation.entries.at(-1).realPath = '/tmp'; }],
  ['nested mount', f => { f.observation.entries.at(-1).deviceId = 3; }],
  ['missing ancestor', f => { f.observation.entries.shift(); }],
  ['traversal', f => { f.policy.stateDirectory = '/srv/siteflow-mysql/data/../poll-state'; }],
  ['CD equals DB', f => { f.policy.stateDirectory = f.policy.mysqlDataDirectory; }],
  ['CD inside DB', f => { f.policy.stateDirectory = `${f.policy.mysqlDataDirectory}/cd`; }],
  ['DB inside CD', f => { f.policy.mysqlDataDirectory = `${f.policy.stateDirectory}/db`; }],
  ['DB path unresolved', f => { f.observation.mysqlDataRealPath = '/tmp/data'; }],
  ['capacity insufficient', f => { f.observation.freeBytes = 256 * 1024 * 1024 - 1; }],
  ['inode insufficient', f => { f.observation.freeInodes = 127; }],
  ['write probe failed', f => { f.observation.writeProbeSucceeded = false; }],
  ['unsafe reserve', f => { f.policy.minFreeBytes = 0; }],
  ['unknown field', f => { f.observation.verified = true; }],
];
for (const [name, modify] of cases) test(`storage refuses ${name}`, () => { const f = fixture(); modify(f); assert.throws(() => assessLinuxStorage(f.policy, f.observation)); });
for (const p of ['/tmp/../etc', '/srv//state', '/srv/state/', '/srv/./state', 'C:\\state', '/', '/tmp/a,b', '/tmp/a\n']) test(`storage refuses unsafe path ${JSON.stringify(p)}`, () => assert.throws(() => assertLinuxPath(p)));
