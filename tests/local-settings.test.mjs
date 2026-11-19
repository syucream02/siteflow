import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findWorkspaceRoot, schemaCheckEnvPath } from '../examples/mysql/schema-check-settings.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
test('ルートと検証フォルダーから同じプロジェクトを見つける', () => {
  assert.equal(findWorkspaceRoot(root), path.resolve(root));
  assert.equal(findWorkspaceRoot(path.join(root, 'examples/mysql')), path.resolve(root));
  assert.equal(fileURLToPath(schemaCheckEnvPath), path.join(root, '.env.schema-check.local'));
});
test('本番ではローカル環境ファイルを読む前に拒否する', () => {
  const moduleUrl = new URL('../examples/mysql/schema-check-settings.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(moduleUrl)}); for(const name of ['readDevelopmentSettings','readSchemaCheckSettings']) {let denied=false;try{m[name]()}catch(e){denied=!e.message.includes('ENOENT')}if(!denied)process.exit(1)}`], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, windowsHide: true });
  assert.equal(result.status, 0);
});
