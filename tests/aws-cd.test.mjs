import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { validateManifest, verifyAdmission, validateSnapshot, assertAction, assertImage, releaseId, hash } from '../deploy/aws/contract.mjs';
import { MemoryLedger } from '../deploy/aws/memory-ledger.mjs';
import { AwsLedger, encode, decode } from '../deploy/aws/ledger.mjs';
import { runRelease } from '../deploy/aws/engine.mjs';
import { liveConfig, processEnvironment, execute } from '../deploy/aws/external.mjs';
import { trustedFile } from '../deploy/aws/verify-attestation.mjs';
import { main as workerMain } from '../deploy/aws/worker.mjs';
import { main as operatorMain } from '../deploy/aws/operator.mjs';

function fixture(mode='candidate') {
  const clock={value:1000}, keys=generateKeyPairSync('ed25519');
  const policy={repositoryId:'123',signerSha:'f'.repeat(40),implementationSha:'9'.repeat(40),manualProtectionReview:{confirmed:true,reviewer:'syucream02',repositoryId:'123',environment:'production',bypassDisabled:true,reviewedAt:900,expiresAt:2000},allowedModes:['candidate','publish']};
  const m={version:2,repository:'syucream02/siteflow',repositoryId:'123',signerWorkflow:'.github/workflows/siteflow-deploy.yml',signerSha:policy.signerSha,implementationSha:policy.implementationSha,protectionReviewHash:hash(JSON.stringify(policy.manualProtectionReview)),releaseId:'deploy-20-1',sha:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64),migrationDigest:'sha256:'+'c'.repeat(64),schemaHash:'d'.repeat(64),ciRunId:'10',ciAttempt:1,deployRunId:'20',attempt:1,runCreatedAt:990,issuedAt:1000,expiresAt:1600,epoch:1,mode};
  const images={image:{repository:'ghcr.io/syucream02/siteflow',digest:m.digest,revision:m.sha},migration:{repository:'ghcr.io/syucream02/siteflow',digest:m.migrationDigest,revision:m.sha},receipt:{verified:true,schemaHash:m.schemaHash,migrationDigest:m.migrationDigest,databaseName:'siteflow_public_app',databaseHost:'mysql.siteflow.test',caMatches:true}};
  const evidence={mainSha:m.sha,ci:{repository:m.repository,id:'10',attempt:1,event:'push',branch:'main',workflow:'.github/workflows/ci.yml',sha:m.sha,status:'completed',conclusion:'success'},deployment:{id:'20',repository:m.repository,ref:'refs/heads/main',attempt:1,createdAt:990,signerSha:m.signerSha},approvals:[{environment:'production',state:'approved',user:'syucream02'}],protection:{reviewers:['syucream02'],bypass:false,bypassReviewHash:m.protectionReviewHash,mainOnly:true},images:{sha:m.sha,digest:m.digest,migrationDigest:m.migrationDigest,schemaHash:m.schemaHash}};
  const ledger=new MemoryLedger(1,900),events=[],lock={held:false};
  const driver={route:'legacy',rollbackFails:false,hook:async()=>{},
    async lock(){assert.equal(lock.held,false,'LOCK_BUSY');lock.held=true;events.push('lock');},
    async unlock(){if(!lock.sticky)lock.held=false;events.push('unlock');},
    async preflight(){events.push('preflight');},
    async effect(name,signal){events.push(name);await this.hook(name,signal);if(signal?.aborted)throw Error('RELEASE_ABORTED');},
    async pull(m,signal){await this.effect('pull',signal);return images;},
    async stage(m,signal){await this.effect('candidate',signal);},
    async ready(m,signal){await this.effect('ready',signal);},
    async switchRoute(m,signal){this.route='blue';await this.effect('switch',signal);},
    async publicReady(m,signal){await this.effect('public-ready',signal);},
    async commit(){await this.effect('commit');},
    async retainCandidate(){await this.effect('retain');},
    async prepareDecision(){await this.effect('prepare');},
    async markIncident(){events.push('incident');},
    holdLock(){lock.sticky=true;},
    async interrupt(){events.push('interrupt');},
    async reconcile(){events.push('reconcile');},
    async rollback(){events.push('rollback');if(this.rollbackFails)throw Error('ROLLBACK_FAILED');this.route='legacy';}
  };
  const bytes=JSON.stringify(m),bundle=sign(null,Buffer.from(bytes),keys.privateKey).toString('base64');
  // Real local Ed25519 verification, NOT a claim of GitHub/Sigstore verification.
  const verifier=async(b,s)=>{if(!verify(null,Buffer.from(b),keys.publicKey,Buffer.from(s,'base64')))throw Error('SIGNATURE_MISMATCH');};
  const f={m,policy,clock,images,evidence,ledger,driver,events,lock,bytes,bundle,verifier};
  f.issue=()=>ledger.issue(m,clock.value,bundle);
  f.run=(overrides={})=>runRelease({manifest:m,bytes:JSON.stringify(m),bundle,policy,verifier,ledger,driver,now:()=>clock.value,pollMs:2,...overrides});
  return f;
}

test('正常許可: 実ローカル署名を検証し候補だけを確認する',async()=>{const f=fixture();verifyAdmission(f.m,f.evidence);f.issue();assert.equal((await f.run()).status,'CANDIDATE_READY');assert.equal(f.driver.route,'legacy');assert(!f.events.includes('switch'));assert(f.ledger.get('USED#deploy-20-1'));});
test('正常公開: readinessを経てコミットする',async()=>{const f=fixture('publish');f.issue();assert.equal((await f.run()).status,'COMMITTED');assert(f.events.indexOf('ready')<f.events.indexOf('switch'));});

const admissionCases=[
 ['本人承認なし',f=>f.evidence.approvals=[]],['別人承認',f=>f.evidence.approvals[0].user='other'],['却下済み',f=>f.evidence.approvals.push({environment:'production',state:'rejected',user:'syucream02'})],
 ['CI失敗',f=>f.evidence.ci.conclusion='failure'],['CI未完了',f=>f.evidence.ci.status='in_progress'],['PR由来CI',f=>f.evidence.ci.event='pull_request'],['別branch',f=>f.evidence.ci.branch='feature'],['別CI repo',f=>f.evidence.ci.repository='other/repo'],['別CI workflow',f=>f.evidence.ci.workflow='other.yml'],
 ['main不一致',f=>f.evidence.mainSha='e'.repeat(40)],['CI SHA不一致',f=>f.evidence.ci.sha='e'.repeat(40)],['CI attempt不一致',f=>f.evidence.ci.attempt=2],['deploy再実行',f=>f.evidence.deployment.attempt=2],
 ['管理者迂回',f=>f.evidence.protection.bypass=true],['main制限なし',f=>f.evidence.protection.mainOnly=false],['承認者追加',f=>f.evidence.protection.reviewers.push('other')],
 ['CI digest不一致',f=>f.evidence.images.digest='sha256:'+'e'.repeat(64)],['CI schema不一致',f=>f.evidence.images.schemaHash='e'.repeat(64)]
];
for(const [name,change] of admissionCases)test(`承認入口拒否: ${name}`,()=>{const f=fixture();change(f);assert.throws(()=>verifyAdmission(f.m,f.evidence));});
const manifestCases=[['別repo',m=>m.repository='other/repo'],['別repo ID',m=>m.repositoryId='456'],['別workflow',m=>m.signerWorkflow='other.yml'],['別signer SHA',m=>m.signerSha='e'.repeat(40)],['不正digest',m=>m.digest='latest'],['不正schema',m=>m.schemaHash='bad'],['期限切れ',m=>m.expiresAt=999],['未来発行',m=>m.issuedAt=1001],['長すぎる期限',m=>m.expiresAt=1601],['再実行attempt',m=>m.attempt=2],['ID偽装',m=>m.releaseId='deploy-21-1'],['SQL追加',m=>m.command='mysql DROP'],['不正操作',m=>m.mode='migrate']];
for(const [name,change] of manifestCases)test(`指示拒否: ${name}`,()=>{const f=fixture();change(f.m);assert.throws(()=>validateManifest(f.m,1000,f.policy));});
test('候補専用policyはpublish署名指示も拒否',()=>{const f=fixture('publish');f.policy.allowedModes=['candidate'];assert.throws(()=>validateManifest(f.m,1000,f.policy));});
test('署名不一致: 内容改変をローカル暗号検証で拒否',async()=>{const f=fixture();f.issue();f.m.digest='sha256:'+'e'.repeat(64);assert.equal((await f.run()).reason,'SIGNATURE_MISMATCH');assert(!f.events.includes('pull'));});
test('署名不一致: 別鍵の署名を拒否',async()=>{const f=fixture();f.issue();const key=generateKeyPairSync('ed25519');const bundle=sign(null,Buffer.from(f.bytes),key.privateKey).toString('base64');assert.equal((await f.run({bundle})).reason,'SIGNATURE_MISMATCH');});
test('bytesとJSONの対応が変わる場合は拒否',async()=>{const f=fixture();f.issue();assert.equal((await f.run({bytes:f.bytes+' '})).reason,'MANIFEST_BYTES_MISMATCH');});
test('STOP記録ありではDockerへ進まない',async()=>{const f=fixture();f.issue();f.ledger.stop(1);assert.equal((await f.run()).reason,'STOP_PRESENT');assert(!f.events.includes('pull'));});
test('世代変更で過去の許可を拒否',async()=>{const f=fixture();f.issue();f.ledger.stop(1);f.ledger.resume(1000);assert.equal((await f.run()).reason,'EPOCH_MISMATCH');});
test('期限切れLEASEはrenewで復活できない',()=>{const f=fixture();f.issue();assert.throws(()=>f.ledger.renew(f.m,1031),/LEASE_CANNOT_REVIVE/);});
test('Actionsキャンセル相当: 更新停止後に安全停止',async()=>{const f=fixture();f.issue();f.clock.value=1031;assert.equal((await f.run()).reason,'LEASE_EXPIRED_OR_INVALID');});
test('通信障害時に開始しない',async()=>{const f=fixture();f.issue();f.ledger.offline(true);assert.equal((await f.run()).status,'ABORTED');assert(!f.events.includes('pull'));});
test('release IDの再利用を拒否',async()=>{const f=fixture();f.issue();await f.run();const second=await f.run();assert.equal(second.reason,'ALREADY_USED');});
test('重複GRANT発行を拒否',()=>{const f=fixture();f.issue();assert.throws(()=>f.issue(),/GRANT_ALREADY_EXISTS/);});
test('ロック中は同時実行を拒否',async()=>{const f=fixture();f.issue();f.lock.held=true;assert.equal((await f.run()).status,'ABORTED');assert(!f.events.includes('pull'));});
test('配信ロールはSTOP/USED/CONTROL/STATEへ書けない',()=>{const f=fixture();for(const key of ['STOP#1','USED#x','CONTROL#production','STATE#x'])assert.throws(()=>f.ledger.putAs('issuer',key,{}),/IAM_WRITE_DENIED/);});
test('停止後に別GRANTを発行しても停止を回避できない',()=>{const f=fixture();f.ledger.stop(1);assert.throws(()=>f.issue(),/ISSUE_STOPPED/);});
test('resumeは古いSTOPを消さず世代を進める',()=>{const f=fixture();f.ledger.stop(1);f.ledger.resume(1001);assert(f.ledger.get('STOP#1'));assert.equal(f.ledger.get('CONTROL#production').epoch,2);});
test('再開より前に作られたrunは新世代でも拒否',()=>{const f=fixture();f.ledger.stop(1);f.ledger.resume(1001);f.m.epoch=2;assert.throws(()=>f.issue(),/ISSUE_STOPPED/);});
for(const point of ['pull','candidate','ready','switch','public-ready','commit'])test(`配信途中STOP: ${point}`,async()=>{const f=fixture('publish');f.issue();f.driver.hook=async name=>{if(name===point)f.ledger.stop(1);};const result=await f.run();assert.equal(result.status,point==='commit'?'COMMITTED':['switch','public-ready'].includes(point)?'ROLLED_BACK':'ABORTED');assert.equal(f.driver.route,point==='commit'?'blue':'legacy');});
test('Docker操作中: 独立pollが中断signalを送る',async()=>{const f=fixture();f.issue();f.driver.hook=(name,signal)=>name==='pull'?new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('RELEASE_ABORTED')),{once:true});setTimeout(()=>f.ledger.stop(1),5);}):Promise.resolve();const result=await f.run();assert.equal(result.status,'ABORTED');assert(!f.events.includes('candidate'));});
test('切替後の通信断でも旧経路へ復旧する',async()=>{const f=fixture('publish');f.issue();f.driver.hook=async name=>{if(name==='switch')f.ledger.offline(true);};assert.equal((await f.run()).status,'ROLLED_BACK');assert.equal(f.driver.route,'legacy');});
test('復旧失敗は成功扱いせず両枠保持の状態を返す',async()=>{const f=fixture('publish');f.issue();f.driver.rollbackFails=true;f.driver.hook=async name=>{if(name==='switch')f.ledger.stop(1);};assert.equal((await f.run()).status,'ROLLBACK_FAILED');});
test('readiness失敗は切り替えない',async()=>{const f=fixture('publish');f.issue();f.driver.hook=async name=>{if(name==='ready')throw Error('READINESS_FAILED');};assert.equal((await f.run()).status,'ABORTED');assert(!f.events.includes('switch'));});
for(const value of ['../bad','deploy-1-2','deploy-0-1','deploy-1-1;id','deploy-1-1\n','$(whoami)','--help'])test(`SSM入力拒否: ${JSON.stringify(value)}`,()=>assert.throws(()=>releaseId(value)));
test('候補確認はNginx操作・commitを拒否',()=>{for(const action of ['nginx-switch','nginx-reload','commit'])assert.throws(()=>assertAction('candidate',action));});
test('正式DB migration/SQL操作を常に拒否',()=>{for(const action of ['migrate','db-push','db-reset','sql'])for(const mode of ['candidate','publish'])assert.throws(()=>assertAction(mode,action),/MIGRATION_FORBIDDEN/);});
for(const field of ['repository','digest','revision'])test(`実イメージ照合拒否: ${field}`,()=>{const f=fixture();f.images.image[field]='wrong';assert.throws(()=>assertImage(f.m,f.images.image,f.images.migration,f.images.receipt));});
for(const field of ['schemaHash','migrationDigest','databaseName','databaseHost','caMatches','verified'])test(`schema証跡拒否: ${field}`,()=>{const f=fixture();f.images.receipt[field]='wrong';assert.throws(()=>assertImage(f.m,f.images.image,f.images.migration,f.images.receipt));});
test('AWS属性形式は空配列を含め往復できる',()=>{const v={pk:'x',empty:[],data:{n:1,b:false,z:null}};assert.deepEqual(decode(encode(v)),v);});
test('AWS実adapterのclaimはSTOP確認と一回限りPutを同transactionにする',async()=>{const f=fixture();f.issue();let input;const client={config:{table:'Fixture'},async call(s,op,value){if(op==='transact-get-items'){const snap=f.ledger.snapshot(f.m);return {Responses:[snap.control,snap.stop,snap.grant,snap.lease].map(x=>x?{Item:encode(x).M}:{})};}input=value;return {};}};await new AwsLedger(client).claim(f.m,1000);assert(input.TransactItems.some(x=>x.ConditionCheck?.Key.pk.S==='STOP#1'));assert(input.TransactItems.some(x=>x.Put?.ConditionExpression==='attribute_not_exists(pk)'));});
test('初期設定では実通信を許可しない',()=>{const config=JSON.parse(fs.readFileSync(new URL('../deploy/aws/settings.example.json',import.meta.url)));assert.throws(()=>liveConfig(config),/LIVE_CONFIGURATION_DISABLED/);});
test('ambient認証・proxy・debug・PATを子プロセスへ持ち込まない',()=>{const env=processEnvironment('offline',{PATH:'fixture',GH_TOKEN:'dummy',GITHUB_TOKEN:'dummy',AWS_SECRET_ACCESS_KEY:'dummy',HTTP_PROXY:'dummy',BASH_ENV:'dummy',DOCKER_CONFIG:'dummy'});for(const k of ['GH_TOKEN','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY','HTTP_PROXY','BASH_ENV','DOCKER_CONFIG'])assert.equal(env[k],undefined);});
test('信頼ファイルのpin未設定はverifier起動前に拒否',()=>assert.throws(()=>trustedFile('relative',''),/TRUST_FILE_NOT_PINNED/));
test('worker/operatorは不正引数を実通信前に拒否',async()=>{await assert.rejects(workerMain([]));await assert.rejects(operatorMain(['stop','not-used']));});
test('子プロセスの生stderrを例外に出さない',async()=>{await assert.rejects(execute(process.execPath,['-e','process.stderr.write("DUMMY_SECRET");process.exit(1)'],{env:{},timeout:5000}),e=>e.message==='EXTERNAL_OPERATION_FAILED'&&!e.message.includes('DUMMY_SECRET'));});
test('子プロセスを期限で終了する',async()=>{await assert.rejects(execute(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{},timeout:20}),/OPERATION_INTERRUPTED/);});

test('遅延した許可更新はローカルで受理済みの期限を復活させない',async()=>{
  const f=fixture();f.issue();
  f.driver.hook=async name=>{if(name==='pull'){f.ledger.renew(f.m,1020);f.clock.value=1031;}};
  assert.equal((await f.run()).reason,'LOCAL_LEASE_EXPIRED');assert(!f.events.includes('candidate'));
});
test('台帳のmanifestとhashが同時に変わっても署名対象と一致しなければ拒否',()=>{
  const f=fixture();f.issue();const snapshot=f.ledger.snapshot(f.m);
  snapshot.grant.manifest='{}';snapshot.grant.manifestHash=hash('{}');
  assert.throws(()=>validateSnapshot(f.m,snapshot,1000),/GRANT_CHANGED/);
});
test('切替直前の期限切れではNginxへ進まない',async()=>{
  const f=fixture('publish');f.issue();f.driver.hook=async name=>{if(name==='ready')f.clock.value=1031;};
  assert.equal((await f.run()).status,'ABORTED');assert(!f.events.includes('switch'));
});
test('例外に秘密相当の自由文があっても結果に返さない',async()=>{
  const f=fixture();f.issue();f.driver.hook=async()=>{throw Error('dummy secret value');};
  assert.equal((await f.run()).reason,'RELEASE_FAILED');
});
const source=name=>fs.readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
test('CIは採用済みpolling契約へ承認記録を戻し保留AWS配信を起動しない',()=>{
  // 方針変更: 「承認jobなし」という旧AWS producer前提だけを置換。AWS安全試験は保持。
  const ci=source('.github/workflows/ci.yml').replaceAll('\r\n','\n'),release=ci.split('\n  release-approved:')[1];
  assert(release);assert.deepEqual([...ci.split('\njobs:\n')[1].matchAll(/^  ([\w-]+):$/gm)].map(m=>m[1]),['docker-build','release-approved']);
  assert(release.includes('needs: docker-build'));assert(release.includes('environment: production'));
  assert(release.includes("github.event_name == 'push'"));assert(release.includes("github.ref == 'refs/heads/main'"));assert(release.includes('github.run_attempt == 1'));
  assert(release.includes("if: steps.release-switch.outputs.enabled == 'true'"));
  assert(release.includes('SITEFLOW_IMAGE_DIGEST: ${{ needs.docker-build.outputs.digest }}'));
  assert(release.includes('SITEFLOW_MIGRATION_DIGEST: ${{ needs.docker-build.outputs.migration_digest }}'));
  assert(!/docker (?:build|pull|push|inspect)|\bssh\b|node deploy\/migrate|publish\.mjs|aws-actions\//.test(release));
  assert(!ci.includes('deploy/aws/ci-record.mjs'));assert(!ci.includes('name: ci-images-'));
  assert(ci.includes('tests/aws-cd.test.mjs'));assert(ci.includes('tests/poll-workflow-policy.test.mjs'));
});
test('新CDは手動起動・準備済み変数・production承認を要求',()=>{
  const request=source('.github/workflows/siteflow-release-request.yml'),signer=source('.github/workflows/siteflow-deploy.yml');
  assert(request.includes('workflow_dispatch:'));assert(!request.includes('workflow_run:'));
  assert(request.includes('cancel-in-progress: false'));assert(signer.includes('environment: production'));
  assert(signer.includes("vars.SITEFLOW_AWS_CD_READY == 'true'"));
  assert(signer.indexOf('test "$SITEFLOW_RELEASE_ENABLED" = true')<signer.indexOf('aws-actions/configure-aws-credentials'));
});
test('固定SSM文書は唯一のrelease ID引数だけを受け取る',()=>{
  const d=JSON.parse(source('deploy/aws/ssm-document.json'));
  assert.deepEqual(Object.keys(d.parameters),['ReleaseId']);
  assert.equal(d.parameters.ReleaseId.interpolationType,'ENV_VAR');
  assert(d.mainSteps[0].inputs.runCommand.every(s=>!s.includes('{{')));
  const wrapper=source('deploy/aws/start-release.sh');assert(!wrapper.includes('eval '));assert(wrapper.includes('systemctl start --wait'));
});
test('IAM案は配信ロールによる保護キー書換と汎用SSMを拒否する形',()=>{
  const p=JSON.parse(source('deploy/aws/issuer-policy.example.json'));
  const deny=p.Statement.find(s=>s.Effect==='Deny'&&s.Action.includes('dynamodb:PutItem'));
  for(const key of ['CONTROL#*','STOP#*','USED#*','STATE#*'])assert(deny.Condition['ForAnyValue:StringLike']['dynamodb:LeadingKeys'].includes(key));
  const ssm=p.Statement.find(s=>s.Effect==='Allow'&&s.Action==='ssm:SendCommand');
  assert.equal(ssm.Resource.length,2);assert(!JSON.stringify(ssm).includes('AWS-RunShellScript'));
  assert(p.Statement.some(s=>s.Effect==='Deny'&&s.NotResource));
});
test('USEDとSTOPにTTL属性を付けず保護記録の自動消滅を防ぐ',()=>{
  const used=JSON.parse(source('deploy/aws/worker-policy.example.json')).Statement.find(s=>s.Action.includes('dynamodb:PutItem')&&s.Effect==='Allow'&&s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']?.includes('USED#*'));
  assert(!used.Condition['ForAllValues:StringEquals']['dynamodb:Attributes'].includes('ttl'));
  const table=JSON.parse(source('deploy/aws/table.example.json'));assert.equal(table.BillingMode,'PAY_PER_REQUEST');assert.equal(table.SSESpecification,undefined);
});
test('systemd案に自動有効化を付けずswap/core制限と障害時回復を指定',()=>{
  const unit=source('deploy/aws/siteflow-aws-release@.service');
  for(const text of ['MemorySwapMax=0','LimitCORE=0','ExecStopPost=','RequiresMountsFor=/srv/siteflow-mysql'])assert(unit.includes(text));
  assert(!unit.includes('[Install]'));assert(!unit.includes('Restart=always'));
});


test('public AWS example stays disabled and keeps an exact non-operational instance target',()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../deploy/aws/settings.example.json',import.meta.url)));
  const policy=JSON.parse(fs.readFileSync(new URL('../deploy/aws/issuer-policy.example.json',import.meta.url)));
  assert.equal(config.liveEnabled,false);
  assert.equal(config.instanceId,'REQUIRES_APPROVED_INSTANCE_ID');
  assert.equal(config.publicOrigin,'https://siteflow.example.invalid');
  assert.throws(()=>liveConfig(config),/LIVE_CONFIGURATION_DISABLED/);
  assert.throws(()=>liveConfig({...config,liveEnabled:true}),/LIVE_CONFIGURATION_DISABLED/);
  const targets=policy.Statement.flatMap(s=>[s.Resource,s.NotResource].flat()).filter(r=>typeof r==='string'&&r.includes(':instance/'));
  assert.equal(targets.length,2);
  assert.ok(targets.every(r=>r.endsWith(':instance/REQUIRES_APPROVED_INSTANCE_ID')&&!r.includes('*')));
});
