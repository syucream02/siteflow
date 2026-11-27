import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { validatePinnedMysqlPublicKey } from '../examples/mysql/schema-check-settings.mjs';

// 一時試験鍵。秘密鍵を保存・出力せず、実MySQLの鍵を使用しない。
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const pin = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
test('固定指紋と一致する2048bit RSA公開鍵を受理する', () => assert.equal(validatePinnedMysqlPublicKey(pem, pin), pem));
for (const [label, value, fingerprint] of [
  ['未設定', undefined, pin], ['未設定指紋', pem, undefined], ['全0指紋', pem, '0'.repeat(64)],
  ['指紋不一致', pem, 'f'.repeat(64)], ['不正PEM', 'invalid', pin], ['サイズ超過', pem + ' '.repeat(4096), pin],
  ['不明な末尾データ', pem + '\0', pin],
]) test(`固定公開鍵は${label}を拒否し内容をエラーへ含めない`, () => {
  assert.throws(() => validatePinnedMysqlPublicKey(value, fingerprint), error => error.message === 'ローカルMySQLの固定RSA公開鍵を確認できません。自動取得せず停止しました。');
});
test('1024bit RSAとEC公開鍵を拒否する', () => {
  for (const key of [generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey]) {
    const hash = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    assert.throws(() => validatePinnedMysqlPublicKey(key.export({ type: 'spki', format: 'pem' }), hash));
  }
});
