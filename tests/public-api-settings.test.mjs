import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicApiSettingsError, readPublicApiSettings } from '../examples/mysql/public-api-settings.ts';

// 形式検証だけの架空値。実際の認証・DB接続には使わない。
const valid = () => ({
  SITEFLOW_PUBLIC_ORIGIN: 'https://demo.example.com',
  SITEFLOW_AUTH_SECRET: 'ab'.repeat(32),
  SITEFLOW_DB_HOST: 'mysql.internal', SITEFLOW_DB_PORT: '3306',
  SITEFLOW_DB_NAME: 'siteflow_public_demo', SITEFLOW_DB_USER: 'siteflow_app',
  SITEFLOW_DB_PASSWORD: 'fictional-password-only', SITEFLOW_DB_TLS: 'required',
});
const rejected = (field, value) => {
  const env = { ...valid(), [field]: value };
  assert.throws(() => readPublicApiSettings(env), error => {
    assert.ok(error instanceof PublicApiSettingsError);
    assert.equal(error.field, field);
    assert.equal(error.message, `公開APIの設定を確認してください: ${field}`);
    assert.equal(error.cause, undefined);
    return true;
  });
};

test('公開専用設定を型付きの結果へ変換し、元の値を変更しない', () => {
  const env = Object.freeze(valid());
  const result = readPublicApiSettings(env);
  assert.equal(result.publicOrigin, env.SITEFLOW_PUBLIC_ORIGIN);
  assert.equal(result.authSecret, env.SITEFLOW_AUTH_SECRET);
  assert.deepEqual(result.database, { host: 'mysql.internal', port: 3306, name: 'siteflow_public_demo', user: 'siteflow_app', password: env.SITEFLOW_DB_PASSWORD, tls: 'required' });
  assert.deepEqual(env, valid());
  assert.notEqual(readPublicApiSettings(env), result);
});
test('必須項目の欠落・空・空白を拒否し、ローカル環境変数へフォールバックしない', () => {
  for (const key of Object.keys(valid())) for (const value of [undefined, '', '  ']) rejected(key, value);
  assert.throws(() => readPublicApiSettings({ MYSQL_HOST: '127.0.0.1', BETTER_AUTH_SECRET: 'ab'.repeat(32) }), { field: 'SITEFLOW_PUBLIC_ORIGIN' });
});
test('公開URLはHTTPSの外部ホストとルートだけを許可する', () => {
  for (const value of ['http://demo.example.com','https://localhost','https://x.localhost','https://x.local','https://x.internal','https://127.0.0.1','https://[::1]','https://user:private@demo.example.com','https://demo.example.com/api','https://demo.example.com/?token=private','https://demo.example.com/#private',' https://demo.example.com','https://demo.example.com\n','https://demo.example.com\\evil','invalid']) rejected('SITEFLOW_PUBLIC_ORIGIN',value);
  assert.equal(readPublicApiSettings({...valid(),SITEFLOW_PUBLIC_ORIGIN:'https://DEMO.example.com/'}).publicOrigin,'https://demo.example.com');
});
test('認証secretは64桁の16進数で単一文字の繰り返しを拒否し、同じ値を保持する', () => {
  for (const value of ['a'.repeat(64),'ab'.repeat(31),'ab'.repeat(33),'g'.repeat(64),' '+ 'ab'.repeat(32)]) rejected('SITEFLOW_AUTH_SECRET',value);
  assert.equal(readPublicApiSettings(valid()).authSecret,readPublicApiSettings(valid()).authSecret);
});
test('DBホストはホスト名またはIPだけで、URL・ソケット・資格情報を拒否する', () => {
  for (const value of ['mysql://private@host','db/other','private@host','/tmp/mysql.sock',' db.example.com','db..example.com','-db.example.com','db.example.com:3306']) rejected('SITEFLOW_DB_HOST',value);
  for (const value of ['127.0.0.1','::1','mysql.internal']) assert.equal(readPublicApiSettings({...valid(),SITEFLOW_DB_HOST:value}).database.host,value);
});
test('DBポートは1〜65535の10進整数だけを許可する', () => {
  for(const value of ['0','65536','-1','3306.0','3e3','03306','3306x',' 3306']) rejected('SITEFLOW_DB_PORT',value);
  for(const value of ['1','65535']) assert.equal(readPublicApiSettings({...valid(),SITEFLOW_DB_PORT:value}).database.port,Number(value));
});
test('公開DB名と実行ユーザーを限定し、通常DB・検証DB・rootを拒否する', () => {
  for(const value of ['siteflow_dev','siteflow_check_demo_12345678','mysql','siteflow_public_','siteflow_public_'+ 'a'.repeat(50),'siteflow_public_demo;DROP']) rejected('SITEFLOW_DB_NAME',value);
  for(const value of ['root','ROOT','user@host','a'.repeat(33)]) rejected('SITEFLOW_DB_USER',value);
  assert.equal(readPublicApiSettings({...valid(),SITEFLOW_DB_NAME:'siteflow_public_'+ 'a'.repeat(48)}).database.name.length,64);
});
test('DBパスワードの空白を勝手に除かず、TLS必須方針を確認する', () => {
  rejected('SITEFLOW_DB_PASSWORD','short');rejected('SITEFLOW_DB_PASSWORD','fictional\0password');
  const password='  fictional-password-only  ';assert.equal(readPublicApiSettings({...valid(),SITEFLOW_DB_PASSWORD:password}).database.password,password);
  for(const value of ['false','optional','REQUIRED']) rejected('SITEFLOW_DB_TLS',value);
});
test('エラーの文字列・JSON・スタックへ設定値や秘密値を含めない', () => {
  for(const field of Object.keys(valid())) {
    const value='PRIVATE_SENTINEL_DO_NOT_LOG';
    const env={...valid(),[field]:field==='SITEFLOW_DB_PASSWORD'?'\0'+value:'!'+value};
    try {readPublicApiSettings(env);assert.fail('Expected rejection');}
    catch(error) {assert.ok(error instanceof PublicApiSettingsError);assert.ok(![String(error),JSON.stringify(error),error.stack].some(text=>text.includes(value)));}
  }
});
