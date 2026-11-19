import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadiness } from '../lib/siteflow/readiness.ts';

const env = { SITEFLOW_WORKSPACE_MODE: 'public-integrated', SITEFLOW_PUBLIC_ORIGIN: 'https://siteflow.test',
  SITEFLOW_AUTH_SECRET: 'ab'.repeat(32), SITEFLOW_DB_HOST: 'mysql.internal', SITEFLOW_DB_PORT: '3306',
  SITEFLOW_DB_NAME: 'siteflow_public_test', SITEFLOW_DB_USER: 'siteflow_app', SITEFLOW_DB_PASSWORD: 'fictional-password-only', SITEFLOW_DB_TLS: 'required' };
const request = host => new Request('http://localhost:3000/api/ready', { headers: { Host: host } });

test('readinessは設定・Host・DB確認が成功した時だけ200を返す', async () => {
  let calls = 0;
  const check = async () => { calls++; };
  const response = await handleReadiness(request('siteflow.test'), env, check);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const [host, settings] of [['evil.invalid', env], ['siteflow.test', { ...env, SITEFLOW_WORKSPACE_MODE: 'disabled' }], ['siteflow.test', { ...env, SITEFLOW_AUTH_SECRET: '' }]]) {
    assert.equal((await handleReadiness(request(host), settings, check)).status, 503);
  }
  assert.equal(calls, 1);
});
test('readinessはDB障害の詳細・秘密情報を返さない', async () => {
  const response = await handleReadiness(request('siteflow.test'), env, async () => { throw Error('PRIVATE_DATABASE_PATH'); });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
});
