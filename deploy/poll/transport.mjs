import { exactFields, need } from './contract.mjs';

// 模擬専用。fetch/https/環境変数による実通信・資格情報探索の既定実装はない。
// exchangeの注入やHTTP成功は本番の真正性証明ではない。任意URL取得APIも公開しない。
export const MOCK_DOWNLOAD_HOST = 'siteflow-artifacts.invalid';
const API = 'https://api.github.com';
const ROOT = '/repos/syucream02/siteflow';
export const PINNED_PATHS = Object.freeze(['.github/workflows/ci.yml', 'deploy/release-record.mjs',
  'deploy/image-record.mjs', 'deploy/schema-hash.mjs', 'scripts/check-deploy-config.mjs', 'Dockerfile']);
const id = x => typeof x === 'string' && /^[1-9][0-9]{0,19}$/.test(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x) && !/^0+$/.test(x);

// JSON.parseへ渡す前に文字列トークンを走査し、重複キー・深すぎる構造を拒否。
// JSON構文そのものは標準JSON.parseに委ねる。本文・パーサー例外は外へ出さない。
export function decodeStrictJson(bytes) {
  try {
    need(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 262144, 'INVALID_JSON_BYTES');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    need(text.charCodeAt(0) !== 0xfeff, 'JSON_BOM_FORBIDDEN');
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        const start = i;
        for (i++; i < text.length; i++) {
          if (text[i] === '\\') { i++; continue; }
          if (text[i] === '"') break;
        }
        let after = i + 1;
        while (/\s/.test(text[after] ?? '') && after < text.length) after++;
        if (text[after] === ':') {
          const keys = stack.at(-1), key = JSON.parse(text.slice(start, i + 1));
          need(keys instanceof Set && !keys.has(key), 'DUPLICATE_JSON_KEY'); keys.add(key);
        }
      } else if (c === '{' || c === '[') {
        stack.push(c === '{' ? new Set() : null); need(stack.length <= 32, 'JSON_TOO_DEEP');
      } else if (c === '}' || c === ']') stack.pop();
    }
    return JSON.parse(text);
  } catch { throw new Error('JSON_REJECTED'); }
}

function parameters(operation, p) {
  let route;
  if (['repository', 'main', 'permission', 'workflow', 'environment'].includes(operation)) {
    exactFields(p, []);
    route = { repository: ROOT, main: `${ROOT}/git/ref/heads/main`,
      permission: `${ROOT}/environments/production/variables/SITEFLOW_RELEASE_ENABLED`,
      workflow: `${ROOT}/actions/workflows/ci.yml`, environment: `${ROOT}/environments/production` }[operation];
  } else if (operation === 'runs') {
    exactFields(p, ['sha', 'page']); need(sha(p.sha) && Number.isInteger(p.page) && p.page >= 1 && p.page <= 5, 'INVALID_PAGE');
    route = `${ROOT}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${p.sha}&per_page=100&page=${p.page}`;
  } else if (['run', 'attempt', 'approvals'].includes(operation)) {
    exactFields(p, ['runId']); need(id(p.runId), 'INVALID_RUN_ID');
    route = `${ROOT}/actions/runs/${p.runId}${{ run: '', attempt: '/attempts/1', approvals: '/approvals' }[operation]}`;
  } else if (['jobs', 'artifacts'].includes(operation)) {
    exactFields(p, ['runId', 'page']); need(id(p.runId) && Number.isInteger(p.page) && p.page >= 1 && p.page <= 5, 'INVALID_PAGE');
    route = `${ROOT}/actions/runs/${p.runId}/${operation === 'jobs' ? 'attempts/1/jobs' : 'artifacts'}?per_page=100&page=${p.page}`;
  } else if (operation === 'artifact') {
    exactFields(p, ['artifactId']); need(id(p.artifactId), 'INVALID_ARTIFACT_ID');
    route = `${ROOT}/actions/artifacts/${p.artifactId}`;
  } else if (operation === 'content') {
    exactFields(p, ['path', 'sha']); need(PINNED_PATHS.includes(p.path) && sha(p.sha), 'INVALID_CONTENT_PATH');
    route = `${ROOT}/contents/${p.path}?ref=${p.sha}`;
  } else if (operation === 'installation') {
    exactFields(p, ['installationId']); need(id(p.installationId), 'INVALID_INSTALLATION_ID');
    route = `/app/installations/${p.installationId}`;
  } else throw new Error('UNKNOWN_API_OPERATION');
  return API + route;
}

function headers(value) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_HEADERS');
  const result = {};
  for (const [k, v] of Object.entries(value)) {
    need(typeof v === 'string' && !/[\r\n]/.test(v) && !Object.hasOwn(result, k.toLowerCase()), 'INVALID_HEADERS');
    result[k.toLowerCase()] = v;
  }
  return result;
}

export function createMockTransport({ exchange, now, timeoutMs = 10000 }) {
  need(typeof exchange === 'function' && typeof now === 'function' && Number.isInteger(timeoutMs) &&
    timeoutMs >= 1 && timeoutMs <= 10000, 'MOCK_TRANSPORT_CONFIG_REQUIRED');
  async function request(url, method, credential, body, limit, kind, redirect = false) {
    let timer;
    const controller = new AbortController();
    try {
      const u = new URL(url);
      need(u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.port &&
        u.hostname === (redirect ? MOCK_DOWNLOAD_HOST : 'api.github.com'), 'DESTINATION_REJECTED');
      const auth = credential ? credential.authorization(now()) : null;
      need(!auth || (typeof auth === 'string' && /^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth)), 'INVALID_AUTHORIZATION');
      const requestHeaders = { Accept: kind === 'json' ? 'application/vnd.github+json' : 'application/zip',
        'User-Agent': 'SiteFlow-mock-only', 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache' };
      if (auth) requestHeaders.Authorization = auth;
      if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
      const work = (async () => {
        const r = await exchange({ url, method, headers: requestHeaders, body, redirect: 'manual', signal: controller.signal });
        need(r && Number.isInteger(r.status), 'INVALID_HTTP_RESPONSE');
        const h = headers(r.headers);
        need(![401, 403, 429].includes(r.status) && h['x-ratelimit-remaining'] !== '0', 'API_AUTH_OR_RATE_REJECTED');
        if (kind === 'redirect') {
          need(r.status === 302 && typeof h.location === 'string', 'ARTIFACT_REDIRECT_REQUIRED');
          const location = new URL(h.location);
          need(location.protocol === 'https:' && location.hostname === MOCK_DOWNLOAD_HOST && !location.port &&
            !location.username && !location.password && !location.hash, 'ARTIFACT_REDIRECT_REJECTED');
          return { location: location.href };
        }
        need(r.status === 200 || (method === 'POST' && r.status === 201), 'HTTP_STATUS_REJECTED');
        const type = h['content-type']?.toLowerCase();
        need(kind === 'json' ? /^(application\/json|application\/vnd\.github\+json)(;\s*charset=utf-8)?$/.test(type ?? '') :
          /^(application\/zip|application\/octet-stream)$/.test(type ?? ''), 'CONTENT_TYPE_REJECTED');
        if (h['content-length'] !== undefined) need(/^\d+$/.test(h['content-length']) && Number(h['content-length']) <= limit, 'RESPONSE_TOO_LARGE');
        const chunks = []; let size = 0;
        const parts = r.body instanceof Uint8Array ? [r.body] : r.body;
        need(parts && (parts[Symbol.iterator] || parts[Symbol.asyncIterator]), 'INVALID_RESPONSE_BODY');
        for await (const chunk of parts) {
          need(chunk instanceof Uint8Array && !controller.signal.aborted, 'INVALID_RESPONSE_CHUNK');
          size += chunk.byteLength; need(size <= limit, 'RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(chunk));
        }
        if (h['content-length'] !== undefined) need(Number(h['content-length']) === size, 'RESPONSE_LENGTH_MISMATCH');
        const bytes = Buffer.concat(chunks);
        return kind === 'json' ? decodeStrictJson(bytes) : bytes;
      })();
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')); }, timeoutMs); });
      return await Promise.race([work, timeout]);
    } catch { controller.abort(); throw new Error('MOCK_HTTP_REJECTED'); }
    finally { clearTimeout(timer); }
  }
  return Object.freeze({
    mode: 'mock-only', executionAllowed: false,
    getJson(operation, p, credential) { return request(parameters(operation, p), 'GET', credential, undefined, 262144, 'json'); },
    issueToken(installationId, repositoryId, credential) {
      need(id(installationId) && Number.isSafeInteger(repositoryId) && repositoryId > 0, 'INVALID_INSTALLATION_TARGET');
      const body = JSON.stringify({ repository_ids: [repositoryId], permissions: { contents: 'read', actions: 'read', environments: 'read', metadata: 'read' } });
      return request(`${API}/app/installations/${installationId}/access_tokens`, 'POST', credential, body, 65536, 'json');
    },
    async downloadArtifact(artifactId, credential) {
      need(id(artifactId), 'INVALID_ARTIFACT_ID');
      const { location } = await request(`${API}${ROOT}/actions/artifacts/${artifactId}/zip`, 'GET', credential, undefined, 0, 'redirect');
      // 取得元の認証ヘッダーは別ホストへ送らない。2回目のredirectは許可しない。
      return request(location, 'GET', null, undefined, 131072, 'zip', true);
    },
  });
}
