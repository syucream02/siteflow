import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const requireCheck = (condition, code) => { if (!condition) throw Error(code); };

export function candidateSettings(env) {
  requireCheck(env.SITEFLOW_CANDIDATE_CHECK_APPROVED === 'yes', 'CANDIDATE_CHECK_APPROVAL_REQUIRED');
  const target = new URL(env.SITEFLOW_CANDIDATE_URL ?? '');
  requireCheck(target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.port && target.pathname === '/' && !target.search && !target.hash && !target.username && !target.password, 'LOOPBACK_TUNNEL_REQUIRED');
  const origin = new URL(env.SITEFLOW_PUBLIC_ORIGIN ?? '');
  requireCheck(origin.protocol === 'https:' && origin.href === origin.origin + '/' && !origin.username && !origin.password, 'HTTPS_ORIGIN_REQUIRED');
  requireCheck(typeof env.SITEFLOW_TEST_EMAIL === 'string' && /^[^\s@]+@example\.invalid$/.test(env.SITEFLOW_TEST_EMAIL), 'FICTIONAL_TEST_ACCOUNT_REQUIRED');
  requireCheck(typeof env.SITEFLOW_TEST_PASSWORD === 'string' && env.SITEFLOW_TEST_PASSWORD.length >= 16, 'TEST_PASSWORD_REQUIRED');
  requireCheck(/^[a-zA-Z0-9_-]{1,100}$/.test(env.SITEFLOW_TEST_TEAM_ID ?? ''), 'TEST_TEAM_REQUIRED');
  return { target, origin, email: env.SITEFLOW_TEST_EMAIL, password: env.SITEFLOW_TEST_PASSWORD, teamId: env.SITEFLOW_TEST_TEAM_ID, write: env.SITEFLOW_CANDIDATE_WRITE_APPROVED === 'yes' };
}

export async function checkCandidate(settings) {
  let cookie;
  const checks = [];
  function request(route, method = 'GET', body, authenticated = true) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: settings.target.hostname, port: settings.target.port, path: route, method,
        headers: { Host: settings.origin.host, Origin: settings.origin.origin, 'x-forwarded-proto': 'https',
          ...(authenticated && cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
        let bytes = 0, text = '';
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) res.destroy(Error('RESPONSE_TOO_LARGE')); else text += chunk; });
        res.on('error', () => reject(Error('CANDIDATE_RESPONSE_FAILED')));
        res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }); } catch { reject(Error('CANDIDATE_INVALID_JSON')); } });
      });
      req.setTimeout(10000, () => req.destroy());
      req.on('error', () => reject(Error('CANDIDATE_CONNECTION_FAILED')));
      req.end(payload);
    });
  }
  async function expect(route, status, method, body, authenticated) {
    const response = await request(route, method, body, authenticated);
    requireCheck(response.status === status, 'CANDIDATE_UNEXPECTED_STATUS');
    return response;
  }
  const base = '/api/siteflow/teams/' + settings.teamId + '/projects';
  let projectId;
  try {
    requireCheck((await expect('/api/ready', 200)).data.ok === true, 'CANDIDATE_NOT_READY');
    await expect(base, 401, 'GET', undefined, false);
    checks.push('readiness200 / 未認証401');
    const login = await expect('/api/siteflow/auth/sign-in/email', 200, 'POST', { email: settings.email, password: settings.password });
    const session = login.headers['set-cookie']?.find(value => /^[^=]*session_token=/.test(value));
    requireCheck(session && /;\s*Secure(?:;|$)/i.test(session) && /;\s*HttpOnly(?:;|$)/i.test(session), 'SECURE_SESSION_REQUIRED');
    cookie = session.split(';')[0];
    const projects = await expect(base, 200);
    requireCheck(Array.isArray(projects.data.items), 'PROJECT_PAGE_REQUIRED');
    checks.push('テストアカウントのログイン / 案件取得');
    if (settings.write) {
      // SiteFlow deliberately reduces login JSON to {ok:true}; fetch the public session separately.
      const session = (await expect('/api/siteflow/auth/get-session', 200)).data;
      requireCheck(typeof session.user?.id === 'string', 'TEST_USER_ID_REQUIRED');
      const created = await expect(base, 201, 'POST', { name: '候補動作確認 ' + randomUUID(), code: 'CANDIDATE-CHECK', dueDate: '2027-04-30', primaryUserId: session.user.id, supportUserIds: [], clientName: '', summary: '架空の動作確認データ', notes: '' });
      projectId = created.data.project?.id;
      requireCheck(typeof projectId === 'string' && /^[a-zA-Z0-9_-]+$/.test(projectId), 'CREATED_PROJECT_ID_REQUIRED');
      const route = base + '/' + projectId;
      const before = (await expect(route, 200)).data.project;
      await expect(route + '/progress', 200, 'PATCH', { expectedVersion: before.version, progress: 25, comment: '候補版の保存確認' });
      requireCheck((await expect(route, 200)).data.project.progress === 25, 'PROJECT_WRITE_NOT_PERSISTED');
      checks.push('専用テスト案件の作成 / 進捗更新 / 再取得');
    }
    return { passed: true, checks, writePerformed: settings.write, ...(projectId ? { projectId } : {}), scope: 'loopback HTTP through operator-managed SSH tunnel; browser HTTPS/Nginx switch not tested' };
  } finally {
    // sign-out failure must not be silently treated as a passed check.
    if (cookie) {
      await expect('/api/siteflow/auth/sign-out', 200, 'POST', {});
      await expect(base, 401);
      cookie = undefined;
      checks.push('ログアウト / 旧session拒否');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkCandidate(candidateSettings(process.env)))); }
  catch { console.error('CANDIDATE_CHECK_FAILED_CHECK_PRIVATE_SETTINGS_NO_AUTOMATIC_RETRY'); process.exitCode = 1; }
}
