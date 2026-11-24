import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { acquireMockRelease } from '../deploy/poll/acquire.mjs';
import { createMockTransport, PINNED_PATHS, MOCK_DOWNLOAD_HOST } from '../deploy/poll/transport.mjs';
const BASE = 1700000000, NOW = BASE + 100, SHA = 'a'.repeat(40), API = 'https://api.github.com/repos/syucream02/siteflow';
const iso = n => new Date(n * 1000).toISOString();
// 不透明な疑似ZIPではなく実ZIPをメモリ生成する。読取パーサーは実yauzlを通す。
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
function fixture(edit = () => {}, onRequest = () => {}) {
  const repo = { id: 11, full_name: 'syucream02/siteflow' };
  const record = { schemaVersion: 1, repository: repo.full_name, workflow: '.github/workflows/ci.yml',
    sha: SHA, runId: '101', attempt: '1', imageRepository: 'ghcr.io/syucream02/siteflow',
    digest: `sha256:${'b'.repeat(64)}`, migrationDigest: `sha256:${'c'.repeat(64)}`, schemaHash: 'd'.repeat(64), approved: true };
  const run = { id: 101, workflow_id: 22, run_attempt: 1, path: '.github/workflows/ci.yml', url: `${API}/actions/runs/101`,
    repository: repo, head_repository: repo, event: 'push', head_branch: 'main', head_sha: SHA,
    status: 'completed', conclusion: 'success', created_at: iso(BASE), updated_at: iso(BASE + 80) };
  const job = (name, id, start, end) => ({ id, name, run_id: 101, run_url: run.url, head_sha: SHA, head_branch: 'main',
    status: 'completed', conclusion: 'success', started_at: iso(BASE + start), completed_at: iso(BASE + end) });
  const bytes = storedZip(record);
  const artifact = { id: 202, name: `approved-release-${SHA}-101-1`, expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size_in_bytes: bytes.length,
    created_at: iso(BASE + 50), expires_at: iso(BASE + 86400), url: `${API}/actions/artifacts/202`,
    archive_download_url: `${API}/actions/artifacts/202/zip`, workflow_run: { id: 101, repository_id: 11,
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
    else if (p.endsWith('/runs/101/artifacts')) body = { total_count: d.artifacts.length, artifacts: d.artifacts };
    else if (p.endsWith('/artifacts/202')) body = d.artifact;
    else if (p.includes('/contents/')) body = d.files[p.split('/contents/')[1]];
    else if (p.endsWith('/runs/101')) body = d.run;
    else throw new Error('UNEXPECTED_MOCK_ROUTE');
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };
  } });
  const config = { transport, credential: { authorization(time) { assert.ok(time >= BASE); return 'Bearer fixture-not-real'; } },
    policy: d.policy, local: d.local, now: () => NOW };
  return { d, config, seen };
}
test('実ZIP・実yauzl・固定模擬HTTPを通して取得しても配信許可を発行しない', async () => {
  const f = fixture(), before = structuredClone({ local: f.d.local, policy: f.d.policy });
  const r = await acquireMockRelease(f.config);
  assert.equal(r.executionAllowed, false); assert.equal(r.acquisition, 'mock-only');
  assert.equal(r.releaseId, 'used-101-a1'); assert.deepEqual({ local: f.d.local, policy: f.d.policy }, before);
  assert.ok(f.seen[0].endsWith('/siteflow')); assert.ok(f.seen[1].endsWith('/git/ref/heads/main'));
  assert.equal(f.seen.filter(p => p.endsWith('/git/ref/heads/main')).length, 2);
});
for (const [name, edit] of [
  ['別repo', d => { d.repository.id = 99; }], ['許可false', d => { d.permission.value = 'false'; }],
  ['attempt2', d => { d.runs[0].run_attempt = 2; }], ['attempt詳細不一致', d => { d.attempt.run_attempt = 2; }],
  ['CI失敗', d => { d.runs[0].conclusion = 'failure'; }], ['CI待機', d => { d.runs[0].status = 'waiting'; }],
  ['承認なし', d => { d.approvals = []; }], ['承認矛盾', d => { d.approvals.push({ ...d.approvals[0], state: 'rejected' }); }],
  ['artifact ID違い', d => { d.artifacts[0].id = 203; }], ['artifact digest違い', d => { d.artifact.digest = `sha256:${'e'.repeat(64)}`; }],
  ['ZIP改ざん', d => { d.bytes[40] ^= 1; }], ['workflowハッシュ違い', d => { d.policy.workflow.hashes['.github/workflows/ci.yml'] = 'e'.repeat(64); }],
  ['release-recordハッシュ違い', d => { d.policy.workflow.hashes['deploy/release-record.mjs'] = 'e'.repeat(64); }],
  ['既消費', d => { d.local.consumedIds = ['used-101-a1']; }], ['migration必要', d => { d.local.migrationRequired = true; }],
  ['ページ重複', d => { d.runs.push(structuredClone(d.runs[0])); }], ['ページ上限', d => { d.runs = Array.from({ length: 501 }, (_, i) => ({ ...d.run, id: i + 1 })); }],
]) {
  test(`取得フローの異常を拒否: ${name}`, async () => {
    const f = fixture(edit); await assert.rejects(acquireMockRelease(f.config), /^Error: MOCK_ACQUISITION_REJECTED$/);
  });
}
test('失敗した最新runから古い成功runへフォールバックしない', async () => {
  const f = fixture(d => { d.runs.push({ ...d.runs[0], id: 102, conclusion: 'failure' }); });
  await assert.rejects(acquireMockRelease(f.config));
  assert.equal(f.seen.some(p => p.endsWith('/runs/101')), false);
});
test('複数ページの全runから最新を選び、重複・ページ変化は拒否', async () => {
  const f = fixture(d => { d.runs = Array.from({ length: 101 }, (_, i) => ({ ...d.run, id: i + 1 })); });
  assert.equal((await acquireMockRelease(f.config)).executionAllowed, false);
  assert.equal(f.seen.filter(p => p.endsWith('/ci.yml/runs')).length, 4);
  const changed = fixture(d => { d.runs = Array.from({ length: 101 }, (_, i) => ({ ...d.run, id: i + 1 })); },
    ({ p, count, d }) => { if (p.endsWith('/ci.yml/runs') && count === 2) d.runs.pop(); });
  await assert.rejects(acquireMockRelease(changed.config));
});
for (const [name, onRequest] of [
  ['main更新', ({ p, count, d }) => { if (p.endsWith('/git/ref/heads/main') && count === 2) d.main.object.sha = 'f'.repeat(40); }],
  ['許可失効', ({ p, count, d }) => { if (p.includes('/variables/') && count === 2) d.permission.value = 'false'; }],
  ['許可世代変更', ({ p, count, d }) => { if (p.includes('/variables/') && count === 2) d.permission.updated_at = iso(BASE + 11); }],
  ['runキャンセル', ({ p, count, d }) => { if (p.endsWith('/runs/101') && count === 2) d.run.conclusion = 'cancelled'; }],
  ['同SHAの新run発生', ({ p, count, d }) => { if (p.endsWith('/ci.yml/runs') && count === 2) d.runs.push({ ...d.run, id: 102 }); }],
  ['artifactの後発失効', ({ p, count, d }) => { if (p.endsWith('/artifacts/202') && count === 2) d.artifact.expired = true; }],
]) {
  test(`最終再確認で競合を拒否: ${name}`, async () => {
    const f = fixture(() => {}, onRequest); await assert.rejects(acquireMockRelease(f.config));
  });
}
test('取得期限・注入時計の逆行・token期限切れを拒否', async () => {
  for (const clock of [(() => { let n = 0; return () => NOW + (n++ ? 301 : 0); })(),
    (() => { let n = 0; return () => NOW - n++; })()]) {
    const f = fixture(); f.config.now = clock; await assert.rejects(acquireMockRelease(f.config));
  }
  const f = fixture(); f.config.now = () => BASE + 3650; await assert.rejects(acquireMockRelease(f.config));
  const expired = fixture(); expired.config.credential.authorization = () => { throw new Error('EXPIRED'); };
  await assert.rejects(acquireMockRelease(expired.config));
});
test('新しいコードに本番ネットワーク・ファイル保存・authorized入口がない', async () => {
  const { readFileSync } = await import('node:fs');
  for (const name of ['app-auth', 'transport', 'acquire', 'archive', 'workflow-policy']) {
    const source = readFileSync(new URL(`../deploy/poll/${name}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:(fs|https|http|net|child_process)|fetch\s*\(|executionAllowed:\s*true/);
  }
});
