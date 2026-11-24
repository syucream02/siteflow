import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { ReleaseDriver, atomic, route } from '../deploy/aws/driver.mjs';
import { ReleaseLock } from '../deploy/aws/release-lock.mjs';
import { recoverRelease } from '../deploy/aws/recovery.mjs';
import { MemoryLedger } from '../deploy/aws/memory-ledger.mjs';
import { AwsLedger, encode, decode } from '../deploy/aws/ledger.mjs';
import { runRelease } from '../deploy/aws/engine.mjs';
import { resolveDecision } from '../deploy/aws/decision.mjs';
import { hash, need, validateManifest, verifyImplementation } from '../deploy/aws/contract.mjs';
import { execute, liveConfig } from '../deploy/aws/external.mjs';
import { publicResult } from '../deploy/aws/report.mjs';
import { GitHubReader } from '../deploy/aws/github.mjs';

const read=file=>fs.readFileSync(file,'utf8');
function harness(t,mode='publish'){
  const boundary=path.resolve('work');fs.mkdirSync(boundary,{recursive:true});
  const root=fs.mkdtempSync(path.join(boundary,'aws-cd-test-'));
  t.after(()=>{assert(path.resolve(root).startsWith(boundary+path.sep+'aws-cd-test-'));fs.rmSync(root,{recursive:true,force:true});});
  const policy={repositoryId:'123',signerSha:'f'.repeat(40),implementationSha:'9'.repeat(40),manualProtectionReview:{confirmed:true,reviewer:'syucream02',repositoryId:'123',environment:'production',bypassDisabled:true,reviewedAt:900,expiresAt:2000},allowedModes:['candidate','publish']};
  const m={version:2,repository:'syucream02/siteflow',repositoryId:'123',signerWorkflow:'.github/workflows/siteflow-deploy.yml',signerSha:policy.signerSha,implementationSha:policy.implementationSha,protectionReviewHash:hash(JSON.stringify(policy.manualProtectionReview)),releaseId:'deploy-20-1',sha:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64),migrationDigest:'sha256:'+'c'.repeat(64),schemaHash:'d'.repeat(64),ciRunId:'10',ciAttempt:1,deployRunId:'20',attempt:1,runCreatedAt:990,issuedAt:1000,expiresAt:1600,epoch:1,mode};
  const f={root,policy,m,now:1000,calls:[],hook:async()=>{},ledger:new MemoryLedger(1,900)};
  f.driver=()=>{
    // Production constructor enforces Linux/root/fixed paths. Only that host
    // setup is replaced. Real stage/switch/journal/finalize/rollback methods run.
    const d=Object.create(ReleaseDriver.prototype);d.root=root;d.m=m;d.read=read;d.write=atomic;d.env={};
    d.journal=path.join(root,`${m.releaseId}.json`);d.config={upstreamFile:path.join(root,'upstream.inc'),publicOrigin:'https://example.invalid',runtime:{network:'fixture',caFile:'dummy',runtimeEnvFile:'dummy',databasePasswordFile:'dummy',authSecretFile:'dummy'}};
    d.guard=new ReleaseLock(root,m.releaseId,{read,write:atomic,alive:()=>false});
    d.tool=async(file,args,signal)=>{
      const operation=[file,...args].join(' ');f.calls.push(operation);
      need(!signal?.aborted,'RELEASE_ABORTED');await f.hook(operation,d,signal);need(!signal?.aborted,'RELEASE_ABORTED');
      if(file==='curl'){
        if(args.includes('--write-out'))return '200';
        if(args.includes('--include'))return 'HTTP/1.1 200 OK\r\nX-SiteFlow-Slot: blue\r\n\r\n{"ok":true}';
        return '{"ok":true}';
      }
      if(file==='docker'&&args[0]==='image')return m.sha;
      if(file==='docker'&&args[0]==='inspect'){
        const fmt=args[2];if(fmt.includes('.State.Running'))return 'true|dummy|aws-release';
        if(fmt.includes('.Config.Image'))return `ghcr.io/syucream02/siteflow@${m.digest}`;
        if(fmt.includes('PortBindings'))return '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3101"}]}';
        if(fmt.includes('NetworkMode'))return 'fixture';
      }
      return '';
    };
    d.preflight=async()=>{
      need(!fs.existsSync(path.join(root,'incident.json')),'LOCAL_RELEASE_PAUSED');
      d.old={slot:'legacy',port:3002};d.before=route('legacy');d.slot='blue';d.port=3101;d.name='siteflow-aws-blue-20';
      d.receipt={verified:true,schemaHash:m.schemaHash,migrationDigest:m.migrationDigest,databaseName:'siteflow_public_app',databaseHost:'mysql.siteflow.test',caMatches:true};
      d.save('RUNNING');
    };
    return d;
  };
  atomic(path.join(root,'upstream.inc'),route('legacy'));
  f.candidate={status:'CANDIDATE_READY',releaseId:'deploy-19-1',name:'siteflow-aws-blue-19',slot:'blue',port:3101,sha:m.sha,digest:m.digest,migrationDigest:m.migrationDigest,schemaHash:m.schemaHash};
  atomic(path.join(root,'candidate.json'),JSON.stringify(f.candidate));
  const keys=generateKeyPairSync('ed25519'),bytes=JSON.stringify(m),bundle=sign(null,Buffer.from(bytes),keys.privateKey);
  f.ledger.issue(m,1000,'fixture');
  f.run=(d=f.driver())=>runRelease({manifest:m,bytes:JSON.stringify(m),bundle,policy,ledger:f.ledger,driver:d,now:()=>f.now,pollMs:2,verifier:async b=>need(verify(null,Buffer.from(b),keys.publicKey,bundle),'SIGNATURE_MISMATCH')});
  return f;
}

test('実ドライバーの候補採用・切替・確定が条件付きFINALの後に記録される',async t=>{
  const f=harness(t);const d=f.driver();const commit=d.commit.bind(d);d.commit=async m=>{assert(f.ledger.get(`FINAL#${m.releaseId}`));return commit(m);};
  assert.equal((await f.run(d)).status,'COMMITTED');assert.equal(JSON.parse(read(d.journal)).status,'COMMITTED');
  assert(!f.calls.some(c=>c.startsWith('docker run')));
  const count=f.calls.length;assert.equal((await f.run()).reason,'RELEASE_ALREADY_RECORDED');
  assert.equal(f.calls.length,count);assert(!fs.existsSync(path.join(f.root,'incident.json')));
});
test('実ドライバーのcandidateだけではNginxを操作しない',async t=>{
  const f=harness(t,'candidate');assert.equal((await f.run()).status,'CANDIDATE_READY');
  assert(!f.calls.some(c=>c.startsWith('nginx')));assert.equal(read(path.join(f.root,'upstream.inc')),route('legacy'));
});
test('候補確認記録なしでpublishを拒否し、新規起動しない',async t=>{
  const f=harness(t);fs.unlinkSync(path.join(f.root,'candidate.json'));
  assert.equal((await f.run()).reason,'COMPLETED_CANDIDATE_REQUIRED');assert(!f.calls.some(c=>/^(docker run|nginx)/.test(c)));
});
for(const field of ['sha','digest','schemaHash','migrationDigest','status','releaseId'])test(`候補記録不一致: ${field}`,async t=>{
  const f=harness(t);f.candidate[field]=field==='releaseId'?f.m.releaseId:'wrong';atomic(path.join(f.root,'candidate.json'),JSON.stringify(f.candidate));
  assert.equal((await f.run()).reason,'CANDIDATE_RECEIPT_MISMATCH');assert(!f.calls.some(c=>c.startsWith('nginx')));
});
test('最終確認前STOPではFINALを書かず旧経路へ復旧',async t=>{
  const f=harness(t);const d=f.driver(),prepare=d.prepareDecision.bind(d);d.prepareDecision=async()=>{await prepare();f.ledger.stop(1);};
  assert.equal((await f.run(d)).status,'ROLLED_BACK');assert(!f.ledger.get(`FINAL#${f.m.releaseId}`));
});
test('最終確認直後のSTOPとFINALを同一条件付き処理で裁定',async t=>{
  const f=harness(t),finish=f.ledger.finish.bind(f.ledger);f.ledger.finish=(m,n)=>{f.ledger.stop(1);return finish(m,n);};
  assert.equal((await f.run()).status,'ROLLED_BACK');assert(f.ledger.get(`ABORT#${f.m.releaseId}`));
});
test('FINALの後のSTOPは確定を取り消さず次の配信を止める',async t=>{
  const f=harness(t),finish=f.ledger.finish.bind(f.ledger);f.ledger.finish=(m,n)=>{finish(m,n);f.ledger.stop(1);};
  assert.equal((await f.run()).status,'COMMITTED');assert(f.ledger.get('STOP#1'));
});
test('完了応答だけ失われた場合はFINALを読み戻してローカル確定',async t=>{
  const f=harness(t),finish=f.ledger.finish.bind(f.ledger);f.ledger.finish=(m,n)=>{finish(m,n);throw Error('RESPONSE_LOST');};
  assert.equal((await f.run()).status,'COMMITTED');assert(fs.existsSync(path.join(f.root,'incident.json')));
});
test('完了未実施の通信失敗はABORTで遅れた完了を禁止して復旧',async t=>{
  const f=harness(t);f.ledger.finish=()=>{throw Error('REQUEST_FAILED');};
  assert.equal((await f.run()).status,'ROLLED_BACK');assert(f.ledger.get(`ABORT#${f.m.releaseId}`));
  assert.throws(()=>MemoryLedger.prototype.finish.call(f.ledger,f.m,1000),/DECISION_ALREADY_MADE/);
});
test('FINALもABORTも確認不能なら未知状態・事故記録・ロックを保持',async t=>{
  const f=harness(t);f.ledger.finish=()=>{f.ledger.offline(true);throw Error('UNAVAILABLE');};
  assert.equal((await f.run()).status,'COMMIT_UNKNOWN');assert.equal(JSON.parse(read(path.join(f.root,`${f.m.releaseId}.json`))).status,'DECIDING');
  assert(fs.existsSync(path.join(f.root,'lock')));assert(fs.existsSync(path.join(f.root,'incident.json')));
  f.ledger.offline(false);assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'ROLLED_BACK');
});
test('未知の完了が実際は成立済みなら復旧は巻き戻さず確定',async t=>{
  const f=harness(t),finish=f.ledger.finish.bind(f.ledger);f.ledger.finish=(m,n)=>{finish(m,n);f.ledger.offline(true);throw Error('UNAVAILABLE');};
  assert.equal((await f.run()).status,'COMMIT_UNKNOWN');f.ledger.offline(false);
  assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'COMMITTED');
});
test('不明時のFINAL読み戻しとABORTの競合はFINALを再確認',async t=>{
  const f=harness(t);f.ledger.claim(f.m,1000);const fence=f.ledger.fence.bind(f.ledger);
  f.ledger.fence=m=>{f.ledger.finish(m,1000);return fence(m);};
  assert.equal((await resolveDecision(f.ledger,f.m)).outcome,'COMMITTED');
});
for(const failure of ['nginx -s reload','curl --disable --fail --silent --output'])test(`復旧失敗でも事故記録とロックを保持: ${failure}`,async t=>{
  const f=harness(t);let switched=false;f.hook=async operation=>{
    if(operation.startsWith('nginx -s reload')&&!switched){switched=true;f.ledger.stop(1);return;}
    if(switched&&operation.startsWith(failure))throw Error('FIXTURE_FAILURE');
  };
  assert.equal((await f.run()).status,'ROLLBACK_FAILED');assert(fs.existsSync(path.join(f.root,'incident.json')));assert(fs.existsSync(path.join(f.root,'lock')));
});
test('事故マーカー永続化失敗では復旧操作を開始せずロックを残す',async t=>{
  const f=harness(t),d=f.driver();d.markIncident=async()=>{throw Error('DISK_FAILURE');};f.hook=async op=>{if(op==='nginx -t')throw Error('BAD_CONFIG');};
  assert.equal((await f.run(d)).status,'INCIDENT_WRITE_FAILED');assert(fs.existsSync(path.join(f.root,'lock')));
  assert(!f.calls.some(c=>c==='nginx -s reload'));
});
test('復旧の最後の記録書込み失敗でも事故状態を保持',async t=>{
  const f=harness(t),d=f.driver(),save=d.save.bind(d);d.save=s=>{if(s==='ROLLED_BACK')throw Error('DISK_FAILURE');return save(s);};
  f.hook=async op=>{if(op==='nginx -s reload')f.ledger.stop(1);};
  assert.equal((await f.run(d)).status,'ROLLBACK_FAILED');assert(fs.existsSync(path.join(f.root,'incident.json')));
});
test('事故状態での新規配信を実preflight入口相当で拒否',async t=>{
  const f=harness(t);atomic(path.join(f.root,'incident.json'),'{}');assert.equal((await f.run()).reason,'LOCAL_RELEASE_PAUSED');assert.equal(f.calls.length,0);
});
test('古い復旧記録は別releaseのactive/lockを変更しない',async t=>{
  const f=harness(t),other=new ReleaseLock(f.root,'deploy-21-1',{read,write:atomic});other.acquire();
  assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'STALE_RECOVERY_IGNORED');assert.equal(f.calls.length,0);other.release();
});
test('生存中の通常配信と復旧は同時実行できない',async t=>{
  const f=harness(t),normal=new ReleaseLock(f.root,f.m.releaseId,{read,write:atomic});normal.acquire();
  const d=f.driver();d.guard=new ReleaseLock(f.root,f.m.releaseId,{read,write:atomic});
  await assert.rejects(recoverRelease(d,f.ledger),/RECOVERY_OWNER_ALIVE/);assert.equal(f.calls.length,0);normal.release();
});
test('復旧処理同士も同じ排他で拒否される',t=>{
  const f=harness(t),a=new ReleaseLock(f.root,f.m.releaseId,{read,write:atomic,pid:111,alive:()=>false});a.acquire();
  const b=new ReleaseLock(f.root,f.m.releaseId,{read,write:atomic,pid:222,alive:()=>false});b.acquire(true);
  const c=new ReleaseLock(f.root,f.m.releaseId,{read,write:atomic,pid:333,alive:()=>false});assert.throws(()=>c.acquire(true));b.release();
});
test('Nginx構文検査の直後に中断したらreloadしない',async t=>{
  const f=harness(t);f.hook=async op=>{if(op==='nginx -t')f.ledger.stop(1);};
  assert.equal((await f.run()).status,'ROLLED_BACK');
  // The single reload is the compensating rollback, never the new route.
  assert.equal(f.calls.filter(c=>c==='nginx -s reload').length,1);assert.equal(read(path.join(f.root,'upstream.inc')),route('legacy'));
});
test('ローカル確定失敗はFINALを残し新規配信を禁止、復旧で再確定',async t=>{
  const f=harness(t),d=f.driver();d.commit=async()=>{throw Error('DISK_FAILURE');};
  assert.equal((await f.run(d)).status,'LOCAL_FINALIZATION_FAILED');assert(f.ledger.get(`FINAL#${f.m.releaseId}`));
  assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'COMMITTED');assert(fs.existsSync(path.join(f.root,'incident.json')));
});
for(const phase of ['BEFORE_FINAL_CHECK','AFTER_FINAL_CHECK','AFTER_FINAL_WRITE'])test(`実Node子プロセス強制終了・永続記録から復旧: ${phase}`,async t=>{
  const f=harness(t);f.ledger.claim(f.m,1000);
  const moduleUrl=new URL('../deploy/aws/release-lock.mjs',import.meta.url).href;
  const contractUrl=new URL('../deploy/aws/contract.mjs',import.meta.url).href,driverUrl=new URL('../deploy/aws/driver.mjs',import.meta.url).href;
  const code=`import fs from 'node:fs';import path from 'node:path';import {ReleaseLock} from ${JSON.stringify(moduleUrl)};import {atomic} from ${JSON.stringify(driverUrl)};import {validateManifest,validateSnapshot} from ${JSON.stringify(contractUrl)};const root=process.argv[1],m=JSON.parse(process.argv[2]);const read=p=>fs.readFileSync(p,'utf8'),write=atomic;new ReleaseLock(root,m.releaseId,{read,write}).acquire();write(path.join(root,m.releaseId+'.json'),JSON.stringify({releaseId:m.releaseId,manifest:m,status:'DECIDING',old:{slot:'legacy',port:3002},before:${JSON.stringify(route('legacy'))},slot:'blue',port:3101,name:'siteflow-aws-blue-19'}));if(${JSON.stringify(phase)}!=="BEFORE_FINAL_CHECK"){validateManifest(m,1000,${JSON.stringify(f.policy)});validateSnapshot(m,${JSON.stringify(f.ledger.snapshot(f.m))},1000);}process.stdout.write("READY");setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,f.root,JSON.stringify(f.m)],{env:{},stdio:['ignore','pipe','ignore'],windowsHide:true});
  const exit=new Promise(resolve=>child.once('close',resolve));
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(Error('CHILD_TIMEOUT'));},5000);child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});child.once('error',reject);});
  if(phase==='AFTER_FINAL_WRITE')f.ledger.finish(f.m,1000);
  child.kill('SIGKILL');await exit;
  const d=f.driver();d.guard=new ReleaseLock(f.root,f.m.releaseId,{read,write:atomic});
  assert.equal((await recoverRelease(d,f.ledger)).status,phase==='AFTER_FINAL_WRITE'?'COMMITTED':'ROLLED_BACK');
});
test('大容量bundleはstdinで渡しargvや一時ファイルへ入れない',async()=>{
  const input=JSON.stringify({bundle:'x'.repeat(131072)});
  const out=await execute(process.execPath,['-e','let n=0;process.stdin.on("data",b=>n+=b.length);process.stdin.on("end",()=>process.stdout.write(String(n)))'],{input,env:{},timeout:5000});
  assert.equal(Number(out),Buffer.byteLength(input));
});
test('ローカル完了ACKの通信失敗を完了と報告しない',async t=>{
  const f=harness(t),state=f.ledger.state.bind(f.ledger);
  f.ledger.state=(id,s)=>{if(s==='LOCAL_COMMITTED')throw Error('ACK_LOST');return state(id,s);};
  assert.equal((await f.run()).status,'LOCAL_FINALIZATION_FAILED');assert(fs.existsSync(path.join(f.root,'lock')));
  f.ledger.state=state;assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'COMMITTED');
  assert.equal(f.ledger.get(`STATE#${f.m.releaseId}`).status,'LOCAL_COMMITTED');
});
test('FINALの内容が対象指示と違う場合は復旧も停止する',async t=>{
  const f=harness(t);f.ledger.finish=()=>{f.ledger.putAs('worker',`FINAL#${f.m.releaseId}`,{manifestHash:'wrong',status:'COMMITTED'});throw Error('UNCERTAIN');};
  assert.equal((await f.run()).status,'COMMIT_UNKNOWN');assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'RECOVERY_UNRESOLVED');
});
test('事故状態は正常な確定後も自動解除されない',async t=>{
  const f=harness(t),finish=f.ledger.finish.bind(f.ledger);f.ledger.finish=(m,n)=>{finish(m,n);throw Error('LOST');};
  assert.equal((await f.run()).status,'COMMITTED');assert(fs.existsSync(path.join(f.root,'incident.json')));
});
test('既に中断したsignalでNginx書換を始めない',async t=>{
  const f=harness(t),d=f.driver();await d.preflight();const control=new AbortController();control.abort();
  await assert.rejects(d.switchRoute(f.m,control.signal,async()=>{}),/RELEASE_ABORTED/);
  assert.equal(f.calls.length,0);assert.equal(read(d.config.upstreamFile),route('legacy'));
});
test('生存する別配信のロックを通常配信が奪わない',async t=>{
  const f=harness(t),lock=new ReleaseLock(f.root,'deploy-21-1',{read,write:atomic});lock.acquire();
  assert.equal((await f.run()).reason,'UNRESOLVED_ACTIVE_RELEASE');assert.equal(f.calls.length,0);lock.release();
});
test('異常なロック所有者情報では復旧がfail-closedになる',async t=>{
  const f=harness(t);fs.mkdirSync(path.join(f.root,'lock'));atomic(path.join(f.root,'active.json'),JSON.stringify({releaseId:f.m.releaseId}));
  await assert.rejects(recoverRelease(f.driver(),f.ledger));assert.equal(f.calls.length,0);
});
test('切替途中の強制終了はAWS通信断でも保存経路へ復旧できる',async t=>{
  const f=harness(t),d=f.driver();await d.lock();await d.preflight();d.save('SWITCHING');d.holdLock();
  atomic(d.config.upstreamFile,route('blue'));f.ledger.offline(true);
  assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'ROLLED_BACK');assert.equal(read(d.config.upstreamFile),route('legacy'));
});
test('確定結果不明の復旧はAWSアカウント照合に失敗したら止まる',async t=>{
  const f=harness(t);f.ledger.finish=()=>{throw Error('FAILED');};f.ledger.fence=()=>{throw Error('FAILED');};
  assert.equal((await f.run()).status,'COMMIT_UNKNOWN');const calls=f.calls.length;
  f.ledger.verifyIdentity=()=>{throw Error('WRONG_AWS_ACCOUNT');};
  assert.equal((await recoverRelease(f.driver(),f.ledger)).status,'RECOVERY_UNRESOLVED');assert.equal(f.calls.length,calls);
});
test('実AWS adapterのFINALはSTOP/ABORT/世代/LEASE/USEDと一括条件付き',async t=>{
  const f=harness(t);f.ledger.claim(f.m,1000);let transaction;
  const client={config:{table:'Fixture'},async call(s,op,input){if(op==='transact-get-items'){const v=f.ledger.snapshot(f.m);return {Responses:[v.control,v.stop,v.grant,v.lease].map(x=>x?{Item:encode(x).M}:{})};}transaction=input;return {};}};
  await new AwsLedger(client).finish(f.m,1000);
  const checks=transaction.TransactItems.filter(x=>x.ConditionCheck).map(x=>x.ConditionCheck.Key.pk.S);
  for(const key of ['CONTROL#production','STOP#1','ABORT#deploy-20-1','LEASE#deploy-20-1','USED#deploy-20-1'])assert(checks.includes(key));
  assert.equal(decode({M:transaction.TransactItems.at(-1).Put.Item}).status,'COMMITTED');
});
test('署名の実装SHAが違う・ゼロ・未設定は拒否',t=>{
  const f=harness(t);for(const v of ['0'.repeat(40),'8'.repeat(40),undefined])assert.throws(()=>verifyImplementation(v,f.policy.implementationSha));
  f.m.implementationSha='8'.repeat(40);assert.throws(()=>validateManifest(f.m,1000,f.policy));
});
test('迂回禁止の本人確認が未設定・期限切れなら拒否',t=>{
  const f=harness(t);f.policy.manualProtectionReview.confirmed=false;assert.throws(()=>validateManifest(f.m,1000,f.policy));
  f.policy.manualProtectionReview.confirmed=true;f.policy.manualProtectionReview.expiresAt=999;assert.throws(()=>validateManifest(f.m,1000,f.policy));
});
test('未設定の実装pinではAWS実行設定も拒否',()=>{
  assert.throws(()=>liveConfig({liveEnabled:true,accountId:'123456789012',region:'ap-southeast-2',instanceId:'REQUIRES_APPROVED_INSTANCE_ID',table:'Fixture',policy:{repositoryId:'123',signerSha:'f'.repeat(40)}}),/TRUST_NOT_CONFIGURED/);
});
test('ログ結果は秘密を含む入力から許可した項目だけを抽出',()=>{
  const r=publicResult('deploy-20-1',{releaseId:'deploy-20-1',status:'COMMITTED',secret:'DUMMY_SECRET'},true);
  assert.deepEqual(r,{releaseId:'deploy-20-1',status:'COMMITTED',reviewRequired:true});assert(!JSON.stringify(r).includes('SECRET'));
});
test('外部Actionは固定SHA形式、未確定pinは明示的に導入保留',()=>{
  for(const file of ['ci.yml','siteflow-deploy.yml','siteflow-release-request.yml']){
    const text=read(new URL('../.github/workflows/'+file,import.meta.url));
    for(const match of text.matchAll(/uses:\s*([^\s]+)/g))assert(/@[a-f0-9]{40}$/.test(match[1]),match[1]);
  }
  const text=read(new URL('../.github/workflows/siteflow-deploy.yml',import.meta.url));
  const checkout=text.match(/ref: '([a-f0-9]{40})'/)[1],env=text.match(/SITEFLOW_IMPLEMENTATION_SHA: '([a-f0-9]{40})'/)[1];
  assert.equal(checkout,env);assert(!text.includes('vars.SITEFLOW_SIGNER_SHA'));
  assert(text.includes('Reject unresolved implementation pin'));
});
test('本人確認済み証跡とAPI保護項目を組合せ、未保証の迂回フィールドへ依存しない',async t=>{
  const f=harness(t),now=Math.floor(Date.now()/1000);f.m.issuedAt=now;f.m.expiresAt=now+600;
  const r=f.policy.manualProtectionReview;r.reviewedAt=now-1;r.expiresAt=now+3600;f.m.protectionReviewHash=hash(JSON.stringify(r));
  const reader=new GitHubReader('dummy-only');
  reader.request=async url=>{
    if(url==='git/ref/heads/main')return {object:{sha:f.m.sha}};
    if(url==='actions/runs/10')return {id:10,head_sha:f.m.sha,run_attempt:1};
    if(url==='actions/runs/20')return {id:20,status:'in_progress',event:'workflow_dispatch'};
    if(url.endsWith('/approvals'))return [{environments:[{id:1,name:'production'}],state:'approved',user:{login:'syucream02'}}];
    if(url==='environments/production')return {id:1,protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{login:'syucream02'}}]}],deployment_branch_policy:{custom_branch_policies:true,protected_branches:false}};
    if(url.endsWith('/deployment-branch-policies'))return {total_count:1,branch_policies:[{name:'main',type:'branch'}]};
    return {workflow_runs:[{id:10,head_sha:f.m.sha,run_attempt:1}]};
  };
  const evidence=await reader.evidence(f.m,{},f.policy);assert.equal(evidence.protection.bypass,false);assert.equal(evidence.protection.bypassReviewHash,f.m.protectionReviewHash);
});
