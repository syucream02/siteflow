import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSecretSetting } from '../examples/mysql/secret-files.ts';

test('秘密ファイルは値を環境変数へ書き戻さず、競合・欠落・複数行を拒否する', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'siteflow-secret-test-'));
  const file=path.join(directory,'fake-secret');
  try {
    fs.writeFileSync(file,'fictional-test-only\n',{mode:0o600});
    const env=Object.freeze({TOKEN_FILE:file});
    assert.equal(readSecretSetting(env,'TOKEN'),'fictional-test-only');
    assert.equal(env.TOKEN,undefined);
    assert.throws(()=>readSecretSetting({...env,TOKEN:'conflict'},'TOKEN'),/SECRET_FILE_UNAVAILABLE/);
    assert.throws(()=>readSecretSetting({TOKEN_FILE:path.join(directory,'missing')},'TOKEN'),/SECRET_FILE_UNAVAILABLE/);
    fs.writeFileSync(file,'line1\nline2');
    assert.throws(()=>readSecretSetting(env,'TOKEN'),/SECRET_FILE_UNAVAILABLE/);
    if(process.platform!=='win32'){
      fs.writeFileSync(file,'fake');fs.chmodSync(file,0o644);
      assert.throws(()=>readSecretSetting(env,'TOKEN'),/SECRET_FILE_UNAVAILABLE/);
    }
  }finally{fs.rmSync(file,{force:true});fs.rmdirSync(directory);}
});
