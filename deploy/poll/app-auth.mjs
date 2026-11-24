import { createPrivateKey, sign } from 'node:crypto';
import { inspect } from 'node:util';
import { exactFields, isTime, need } from './contract.mjs';
import { githubTime } from './github.mjs';

// 実鍵の探索・ファイル読取は行わない。テストでメモリ生成した鍵だけを渡す。
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const permissionKeys = ['actions', 'contents', 'environments', 'metadata'];
function permissions(value) {
  exactFields(value, permissionKeys, 'INVALID_APP_PERMISSIONS');
  need(permissionKeys.every(k => value[k] === 'read'), 'APP_PERMISSIONS_NOT_READ_ONLY');
}
function credential(value, expiresAt) {
  need(typeof value === 'string' && /^[A-Za-z0-9._~-]{1,8192}$/.test(value), 'INVALID_CREDENTIAL');
  return Object.freeze({
    expiresAt, mode: 'mock-only',
    authorization(now) { need(isTime(now) && now < expiresAt, 'CREDENTIAL_EXPIRED'); return `Bearer ${value}`; },
    toJSON() { return { mode: 'mock-only', expiresAt }; },
    [inspect.custom]() { return '[REDACTED MOCK CREDENTIAL]'; },
  });
}

export function createAppJwt({ appId, privateKey, now, ttlSeconds = 300 }) {
  try {
    need(id(appId) && isTime(now) && now >= 60 && Number.isInteger(ttlSeconds) &&
      ttlSeconds > 0 && ttlSeconds <= 600 && isTime(now + ttlSeconds), 'INVALID_JWT_SETTINGS');
    const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
    need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048, 'RSA_KEY_REQUIRED');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + ttlSeconds, iss: appId })}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    return credential(`${unsigned}.${signature}`, now + ttlSeconds);
  } catch { throw new Error('APP_JWT_REJECTED'); }
}

export function createMockAppAuth(config) {
  exactFields(config, ['appId', 'installationId', 'repositoryId', 'privateKey', 'transport', 'now']);
  const { appId, installationId, repositoryId, privateKey, transport, now } = config;
  need(id(appId) && id(installationId) && Number.isSafeInteger(repositoryId) && repositoryId > 0 &&
    transport?.mode === 'mock-only' && typeof now === 'function', 'MOCK_APP_CONFIG_REQUIRED');
  return Object.freeze({ mode: 'mock-only', executionAllowed: false, async getCredential() {
    try {
      const started = now(), jwt = createAppJwt({ appId, privateKey, now: started });
      const installation = await transport.getJson('installation', { installationId }, jwt);
      need(String(installation.id) === installationId && String(installation.app_id) === appId &&
        Number.isSafeInteger(installation.id) && Number.isSafeInteger(installation.app_id) &&
        installation.account?.login === 'syucream02' && installation.repository_selection === 'selected' &&
        installation.suspended_at === null, 'INSTALLATION_MISMATCH');
      permissions(installation.permissions);
      const requestedAt = now();
      need(isTime(requestedAt) && requestedAt >= started && requestedAt < jwt.expiresAt, 'JWT_EXPIRED');
      const result = await transport.issueToken(installationId, repositoryId, jwt);
      permissions(result.permissions);
      need(result.repository_selection === 'selected' && Array.isArray(result.repositories) && result.repositories.length === 1 &&
        result.repositories[0].id === repositoryId && result.repositories[0].full_name === 'syucream02/siteflow', 'TOKEN_REPOSITORY_MISMATCH');
      const expiresAt = githubTime(result.expires_at), current = now();
      // tokenは通信開始時ではなくサーバーでの発行から1時間。
      // 発行時刻自体は応答にないため、受信時刻+1時間を保守的な上限とする。
      // 時計逆行や未知のずれを自動補正せず、期限にも猶予を加えない。
      need(isTime(current) && current >= requestedAt && current < jwt.expiresAt && isTime(current + 3600) &&
        expiresAt > current && expiresAt <= current + 3600, 'TOKEN_EXPIRY_REJECTED');
      return credential(result.token, expiresAt);
    } catch { throw new Error('MOCK_APP_AUTH_REJECTED'); }
  } });
}
