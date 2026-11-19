import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReleaseRecord } from '../deploy/release-record.mjs';

const sha = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64);
const env = { SITEFLOW_RELEASE_ENABLED: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'syucream02/siteflow', GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', SITEFLOW_IMAGE_DIGEST: digest, SITEFLOW_MIGRATION_DIGEST: 'sha256:' + 'c'.repeat(64), SITEFLOW_SCHEMA_HASH:'f'.repeat(64) };
test('承認記録はmain push・明示許可・固定digestが必要', () => {
  assert.equal(createReleaseRecord(env).approved, true);
  for (const [key, value] of [['SITEFLOW_RELEASE_ENABLED',undefined],['SITEFLOW_RELEASE_ENABLED','false'],['GITHUB_EVENT_NAME','pull_request'],['GITHUB_REF','refs/heads/dev'],['GITHUB_REPOSITORY','other/repo'],['GITHUB_RUN_ID',''],['GITHUB_RUN_ATTEMPT','0'],['GITHUB_SHA','latest'],['SITEFLOW_IMAGE_DIGEST','latest'],['SITEFLOW_MIGRATION_DIGEST','']]) assert.throws(() => createReleaseRecord({ ...env, [key]: value }));
});

const mock = `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const tool=path.basename(process.argv[1]); const scenario=process.env.SCENARIO;
fs.appendFileSync(process.env.LOG,JSON.stringify({tool,args})+'\\n');
if(tool==='docker'){
 if(args[0]==='context'){console.log('unix:///var/run/docker.sock');process.exit(0);}
 if(args[0]==='container'&&args[1]==='inspect'&&args.includes('--format')){
  const current=JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.UPSTREAM_FILE),'current.json'),'utf8'));
  if(args[2]===current.container&&/^siteflow-(blue|green)-/.test(current.container)){
   const format=args.at(-1);
   if(format.includes('siteflow.managed'))console.log(scenario==='same-foreign'?'other':'release');
   else if(format.includes('Config.Image'))console.log(scenario==='same-image'?'wrong-image':current.image);
   else if(format.includes('State.Running'))console.log(scenario==='same-stopped'?'false':'true');
   else if(format.includes('State.OOMKilled'))console.log(scenario==='same-oom'?'true':'false');
   else if(format.includes('PortBindings'))console.log(JSON.stringify({'3000/tcp':[{HostIp:'127.0.0.1',HostPort:scenario==='same-port'?'3999':String(current.port)}]}));
   process.exit(0);
  }
 }
 if(args[0]==='container'&&args[2]==='siteflow-blue-cccccccccccc-r100a1'){
  if(args.at(-1).includes('siteflow.managed'))console.log(scenario==='reuse-foreign'?'other':'release');
  if(args.at(-1).includes('Config.Image'))console.log('ghcr.io/syucream02/siteflow@sha256:'+'e'.repeat(64));
  if(args.at(-1).includes('State.Running'))console.log('true');
  process.exit(0);
 }
 if(scenario.startsWith('db-')){
  if(args[0]==='volume'||args[0]==='network'){
   if(scenario.startsWith('db-ebs')&&args[0]==='volume'){
    const format=args.at(-1);if(format.includes('.Driver')){console.log('local');process.exit(0);}
    if(format.includes('"device"')){console.log(scenario==='db-ebs-bind'?'/wrong/mysql':'/srv/siteflow-mysql/mysql');process.exit(0);}
    if(format.includes('"type"')){console.log('none');process.exit(0);}
    if(format.includes('"o"')){console.log('bind');process.exit(0);}
   }
   if(scenario==='db-missing')process.exit(1);
   console.log(scenario==='db-foreign'?'unrelated':'production-db');process.exit(0);
  }
  if(args[0]==='run'){if(scenario==='db-empty'||scenario==='db-init-existing')process.exit(1);process.exit(0);}
  if(args[0]==='compose'){if(scenario==='db-config'&&args.includes('config'))process.exit(1);process.exit(0);}
 }
 if(args[0]==='container'&&args[1]==='inspect')process.exit(scenario==='existing'?0:1);
 if(args[0]==='pull'&&scenario==='pull')process.exit(1);
 if(args[0]==='image'){const migration=args[2].endsWith('c'.repeat(64));console.log((migration?scenario==='migration-revision':['revision','same-revision'].includes(scenario))?'wrong':process.env.SHA);}
 if(args[0]==='run'){
  fs.writeFileSync(process.env.LOG+'.started','');
  const id='d'.repeat(64);fs.writeFileSync(args[args.indexOf('--cidfile')+1],id);
  if(scenario==='start')process.exit(1);
  if(scenario==='pause-after-start')fs.writeFileSync(process.env.PAUSED,'');
  console.log(id);
 }
}
if(tool==='mountpoint'){process.exit(scenario==='db-ebs-missing'?1:0);}
if(tool==='readlink'){console.log('/srv/siteflow-mysql');process.exit(0);}
if(tool==='findmnt'){
 if(scenario==='db-ebs-missing')process.exit(1);
 if(args.at(-1)==='UUID')console.log(['db-ebs-wrong-uuid','app-wrong-uuid'].includes(scenario)?'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
 else if(args.at(-1)==='FSTYPE')console.log(scenario==='db-ebs-wrong-fs'?'ext4':'xfs');
 else console.log('/dev/nvme1n1');process.exit(0);
}
if(tool==='lsblk'){console.log(scenario==='db-ebs-wrong-id'?'volbbbbbbbbbbbbbbbbb':'volaaaaaaaaaaaaaaaaa');process.exit(0);}
if(tool==='ss'&&scenario==='reuse-busy')console.log('ESTABLISHED_ACTIVE_REQUEST');
if(tool==='curl'){
 if(args.includes('--output'))fs.writeFileSync(args[args.indexOf('--output')+1],JSON.stringify({ok:true}));
 if(args.includes('--dump-header')){
  const contents=fs.readFileSync(process.env.UPSTREAM_FILE,'utf8');const slot=contents.includes('slot blue')&&scenario!=='wrong-route'?'blue':contents.includes('slot legacy')?'legacy':'green';
  fs.writeFileSync(args[args.indexOf('--dump-header')+1],'X-SiteFlow-Slot: '+slot+'\\r\\n');
 }
 const url=args.find(x=>x.startsWith('https://api.github.com/'));
 if(url){
  if(url.endsWith('/variables/SITEFLOW_RELEASE_ENABLED')){
   const marker=process.env.LOG+'.permission';const count=(fs.existsSync(marker)?Number(fs.readFileSync(marker)):0)+1;fs.writeFileSync(marker,String(count));
   if(scenario==='cd-permission-network')process.exit(6);
   if(['cd-permission-403','cd-permission-401','cd-permission-404','cd-permission-500'].includes(scenario))process.exit(22);
   if(scenario==='cd-permission-invalid-json'){console.log('{');console.log('200');process.exit(0);}
   let value='true',version='2026-01-01T00:00:00Z';
   if(scenario==='cd-permission-false')value='false';
   if(scenario==='cd-permission-missing')value=undefined;
   if(scenario==='cd-permission-boolean')value=true;
   if(scenario==='cd-permission-upper')value='TRUE';
   if(scenario==='cd-permission-space')value='true ';
   if(scenario==='cd-permission-late-false'&&count>=2)value='false';
   if(scenario==='cd-permission-before-pull'&&count>=4)value='false';
   if(scenario==='cd-permission-after-start'&&fs.existsSync(process.env.LOG+'.started'))value='false';
   if(scenario==='cd-permission-after-switch'&&fs.readFileSync(process.env.UPSTREAM_FILE,'utf8').includes('slot blue'))value='false';
   if(scenario==='cd-permission-version-change'&&count>=2)version='2026-01-02T00:00:00Z';
   if(scenario==='cd-permission-newer-than-approval')version=new Date().toISOString();
   const response={name:scenario==='cd-permission-wrong-name'?'OTHER':'SITEFLOW_RELEASE_ENABLED',value,updated_at:scenario==='cd-permission-no-version'?undefined:version};
   console.log(scenario==='cd-permission-array'?'[]':JSON.stringify(response));
   if(scenario!=='cd-permission-no-http-status')console.log(scenario==='cd-permission-redirect'?'302':'200');process.exit(0);
  }
  const sha=process.env.SHA;
  const run={id:123,run_attempt:1,head_sha:sha,event:'push',head_branch:'main',repository:{full_name:'syucream02/siteflow'},head_repository:{full_name:'syucream02/siteflow'},path:'.github/workflows/ci.yml',status:'completed',conclusion:'success'};
  if(scenario==='cd-pr')run.event='pull_request';
  if(scenario==='cd-other-repo')run.head_repository.full_name='other/repo';
  if(scenario==='cd-failed')run.conclusion='failure';
  if(scenario==='cd-pending')run.status='in_progress';
  if(url.includes('/deployment-branch-policies'))console.log(JSON.stringify({total_count:1,branch_policies:[{name:scenario==='cd-wrong-branch'?'*':'main',type:'branch'}]}));
  else if(url.includes('/environments/'))console.log(JSON.stringify({id:321,can_admins_bypass:scenario==='cd-admin-bypass',deployment_branch_policy:{protected_branches:false,custom_branch_policies:true},protection_rules:scenario==='cd-unprotected'?[]:[{type:'required_reviewers',prevent_self_review:scenario==='cd-self-review',reviewers:[{type:'User',reviewer:{login:scenario==='cd-other-reviewer'?'someone-else':'syucream02'}}]}]}));
  else if(url.endsWith('/approvals'))console.log(JSON.stringify(scenario==='cd-no-owner-approval'?[]:[{state:'approved',user:{login:scenario==='cd-other-approver'?'someone-else':'syucream02'},environments:[{id:321,name:'production'}]}]));
  else if(url.includes('/git/ref/')){
   const marker=process.env.LOG+'.main';const second=fs.existsSync(marker);fs.writeFileSync(marker,'');
   if(second&&scenario==='cd-pause')fs.writeFileSync(process.env.PAUSED,'');
   console.log(JSON.stringify({object:{sha:second&&scenario==='cd-main-changed'?'f'.repeat(40):sha}}));
  }else if(url.includes('/workflows/')){
   const runs=[run];if(scenario==='cd-stale')runs.push({...run,id:124,conclusion:'failure'});
   console.log(JSON.stringify({workflow_runs:runs}));
  }else if(url.includes('/jobs?'))console.log(JSON.stringify({jobs:[{name:'release-approved',status:'completed',conclusion:scenario==='cd-job-skipped'?'skipped':'success'}]}));
  else if(url.includes('/artifacts?'))console.log(JSON.stringify({artifacts:[{name:'approved-release-'+sha+'-123-1',expired:scenario==='cd-expired',id:456,created_at:scenario==='cd-artifact-no-time'?undefined:scenario==='cd-artifact-invalid-time'?'not-a-date':new Date(Date.now()+(scenario==='cd-artifact-future'?60000:scenario==='cd-artifact-old'?-3601000:scenario==='cd-permission-newer-than-approval'?-60000:0)).toISOString()}]}));
  else if(url.endsWith('/456/zip'))process.stdout.write(fs.readFileSync(process.env.ARTIFACT_ZIP));
  else process.exit(1);
  process.exit(0);
 }
 if(scenario==='readiness'&&args.some(x=>x.startsWith('http://')))process.exit(1);
 if(scenario==='same-readiness'&&args.some(x=>x.startsWith('http://')))process.exit(1);
 if(scenario==='same-public'&&args.some(x=>x.startsWith('https://')))process.exit(1);
 if(scenario==='https'&&args.some(x=>x.startsWith('https://')))process.exit(1);
 if(scenario==='pause-after-readiness'&&args.some(x=>x.startsWith('http://')))fs.writeFileSync(process.env.PAUSED,'');
 if(!args.includes('--output'))console.log(JSON.stringify({ok:true}));
}
if(tool==='nginx'){
 if(scenario==='rollback-failure')process.exit(1);
 if((scenario==='nginx-test'&&args[0]==='-t')||(scenario==='reload'&&args[0]==='-s')){
   const marker=process.env.LOG+'.once';if(!fs.existsSync(marker)){fs.writeFileSync(marker,'');process.exit(1);}
 }
}
`;
function fixture(scenario) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'siteflow-deploy-test-'));
  const secretDirectory=path.join('/srv/siteflow-mysql',path.basename(directory));
  fs.mkdirSync(secretDirectory,{recursive:true});
  for(const name of ['db-password','auth-secret']){const file=path.join(secretDirectory,name);fs.writeFileSync(file,'fictional-test-only\n',{mode:0o400});fs.chownSync(file,1000,1000);}
  const bin=path.join(directory,'bin');fs.mkdirSync(bin);
  for(const tool of ['docker','curl','nginx','sleep','ss','findmnt','lsblk','mountpoint','readlink'])fs.writeFileSync(path.join(bin,tool),tool==='sleep'?'#!/bin/sh\nexit 0\n':mock,{mode:0o700});
  const manifest=path.join(directory,'manifest.json'),settings=path.join(directory,'settings.json'),upstream=path.join(directory,'upstream.conf');
  fs.writeFileSync(manifest,JSON.stringify(createReleaseRecord(env)));fs.writeFileSync(upstream,'proxy_pass http://127.0.0.1:3102;\nset $siteflow_slot green;\n');
  fs.writeFileSync(path.join(directory,'runtime.env'),'SITEFLOW_DB_USER=fixture_app\nSITEFLOW_DB_PASSWORD_FILE=/run/secrets/db-password\nSITEFLOW_AUTH_SECRET_FILE=/run/secrets/auth-secret\n',{mode:0o600});fs.writeFileSync(path.join(directory,'ca.pem'),'PUBLIC_CERT_FIXTURE');fs.writeFileSync(path.join(directory,'enabled'),'');
  const releaseToken=path.join(secretDirectory,'release-token');fs.writeFileSync(releaseToken,'fictional_test_token',{mode:0o600});
  fs.writeFileSync(path.join(directory,'current.json'),JSON.stringify({slot:'green',port:3102,container:'old-vinext',image:'old-image'}));
  fs.writeFileSync(settings,JSON.stringify({stateDirectory:directory,upstreamFile:upstream,runtimeEnvFile:path.join(directory,'runtime.env'),caFile:path.join(directory,'ca.pem'),network:'siteflow-test',publicOrigin:'https://siteflow.example.com',databaseName:'siteflow_public_fixture',databaseHost:'mysql.siteflow.test',databasePasswordFile:path.join(secretDirectory,'db-password'),authSecretFile:path.join(secretDirectory,'auth-secret'),dataMount:'/srv/siteflow-mysql',dataFsUuid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',dataEbsVolumeId:'vol-aaaaaaaaaaaaaaaaa'}));
  fs.writeFileSync(path.join(directory,'schema.json'),JSON.stringify({schemaVersion:1,verified:true,migrationDigest:env.SITEFLOW_MIGRATION_DIGEST,schemaHash:env.SITEFLOW_SCHEMA_HASH,databaseName:'siteflow_public_fixture',databaseHost:'mysql.siteflow.test',caSha256:createHash('sha256').update('PUBLIC_CERT_FIXTURE').digest('hex')}));
  const log=path.join(directory,'events.log');
  return {directory,secretDirectory,manifest,settings,upstream,log,run:(extra={})=>spawnSync('bash',['deploy/release.sh',manifest,settings,releaseToken],{encoding:'utf8',env:{...process.env,SITEFLOW_CD_PERMISSION_VERSION:'2026-01-01T00:00:00Z',SITEFLOW_CD_APPROVAL_EXPIRES_EPOCH:String(Math.floor(Date.now()/1000)+3600),PATH:bin+':'+process.env.PATH,SCENARIO:scenario,LOG:log,SHA:sha,PAUSED:path.join(directory,'paused'),UPSTREAM_FILE:upstream,...extra},timeout:20000}),close:()=>{
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('siteflow-deploy-test-'));fs.rmSync(directory,{recursive:true,force:true});
    assert.equal(path.dirname(path.resolve(secretDirectory)),'/srv/siteflow-mysql');assert.ok(path.basename(secretDirectory).startsWith('siteflow-deploy-test-'));fs.rmSync(secretDirectory,{recursive:true,force:true});
  }};
}
test('配信シェルの構文が正しい', {skip:process.platform==='win32'}, () => {
  for(const file of ['deploy/release.sh','deploy/cd-check.sh','deploy/check-release-permission.sh','deploy/start-database.sh','deploy/check-database-mount.sh','deploy/check-app-secrets.sh','deploy/recover-candidate.sh'])assert.equal(spawnSync('bash',['-n',file]).status,0);
});

test('復旧コマンドは明示承認なしでrestartを実行しない',{skip:process.platform==='win32'},()=>{
 for(const mode of ['restart-db','restart-candidate','stop-candidate']){
  const result=spawnSync('bash',['deploy/recover-candidate.sh',mode],{encoding:'utf8',env:{...process.env,SITEFLOW_RECOVERY_APPROVED:''}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/RECOVERY_APPROVAL_REQUIRED/);
 }
});

for(const scenario of ['app-wrong-uuid','app-secret-mode','app-plaintext-env'])test(`配信前に秘密保護の不備を拒否する: ${scenario}`,{skip:process.platform==='win32'},()=>{
 const f=fixture(scenario);try{
  if(scenario==='app-secret-mode')fs.chmodSync(path.join(f.secretDirectory,'db-password'),0o444);
  if(scenario==='app-plaintext-env')fs.appendFileSync(path.join(f.directory,'runtime.env'),'SITEFLOW_DB_PASSWORD=fictional-not-allowed\n');
  const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,scenario==='app-wrong-uuid'?/DATA_UUID_MISMATCH[\s\S]*RELEASE_PERMISSION_REJECTED/:/APP_SECRET_PROTECTION_FAILED/);
  const events=fs.existsSync(f.log)?fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse):[];
  assert.ok(!events.some(e=>e.tool==='docker'&&['pull','run','stop','rm'].includes(e.args[0])));
 }finally{f.close();}
});

for(const scenario of ['db-resume','db-init-empty','db-empty','db-init-existing','db-missing','db-foreign','db-config','db-ebs-ok','db-ebs-missing','db-ebs-wrong-id','db-ebs-bind','db-ebs-wrong-uuid','db-ebs-wrong-fs'])test(`MySQLの起動は保存領域とモードを確認する: ${scenario}`,{skip:process.platform==='win32'},()=>{
  const f=fixture(scenario);try{
    const r=spawnSync('bash',['deploy/start-database.sh'],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:path.join(f.directory,'bin')+':'+process.env.PATH,SCENARIO:scenario,LOG:f.log,SITEFLOW_MYSQL_IMAGE:'mysql@'+digest,SITEFLOW_MYSQL_VOLUME:'fixture-volume',SITEFLOW_DATABASE_NETWORK:'fixture-network',SITEFLOW_DATABASE_INITIALIZE_APPROVED:scenario.startsWith('db-init')?'yes':'',...(scenario.startsWith('db-ebs')?{SITEFLOW_MYSQL_DATA_MOUNT:'/srv/siteflow-mysql',SITEFLOW_MYSQL_EBS_VOLUME_ID:'vol-aaaaaaaaaaaaaaaaa',SITEFLOW_MYSQL_FS_UUID:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}:{})}});
    const success=['db-resume','db-init-empty','db-ebs-ok'].includes(scenario);assert.equal(r.status===0,success,r.stdout+r.stderr);
    const events=(fs.existsSync(f.log)?fs.readFileSync(f.log,'utf8'):'').split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(events.some(e=>e.args[0]==='compose'&&e.args.includes('up')),success);
    assert.ok(!events.some(e=>['rm','create','prune'].some(word=>e.args.includes(word)&&e.args[0]!=='run')));
  }finally{f.close();}
});

function zipRecord(record) {
  const name=Buffer.from('approved-release.json'),data=Buffer.from(JSON.stringify(record));
  let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+data.length,16);
  return Buffer.concat([local,name,data,central,name,end]);
}
for(const scenario of ['cd-success','cd-admin-bypass','cd-unprotected','cd-self-review','cd-other-reviewer','cd-no-owner-approval','cd-other-approver','cd-wrong-branch','cd-pr','cd-other-repo','cd-failed','cd-pending','cd-stale','cd-job-skipped','cd-expired','cd-main-changed','cd-pause','cd-record-mismatch'])test(`CDはGitHubのrun・承認ジョブ・成果物を照合する: ${scenario}`,{skip:process.platform==='win32'},()=>{
  const f=fixture(scenario);try{
    const record=createReleaseRecord(env);if(scenario==='cd-record-mismatch')record.attempt='2';
    const archive=path.join(f.directory,'artifact.zip');fs.writeFileSync(archive,zipRecord(record));
    const token=path.join(f.secretDirectory,'token');fs.writeFileSync(token,'fictional_test_token',{mode:0o600});
    // fixtureが生成した同じ代役PATHを再利用し、CDの実シェルを通す。
    const r=spawnSync('bash',['deploy/cd-check.sh',f.settings,token],{encoding:'utf8',timeout:15000,env:{...process.env,PATH:path.join(f.directory,'bin')+':'+process.env.PATH,SCENARIO:scenario,LOG:f.log,SHA:sha,PAUSED:path.join(f.directory,'paused'),ARTIFACT_ZIP:archive,UPSTREAM_FILE:f.upstream}});
    assert.equal(r.status===0,scenario==='cd-success',r.stdout+r.stderr);
    const state=JSON.parse(fs.readFileSync(path.join(f.directory,'current.json'),'utf8'));
    assert.equal(state.slot,scenario==='cd-success'?'blue':'green');
  }finally{f.close();}
});
const permissionFailures=['cd-permission-false','cd-permission-missing','cd-permission-boolean','cd-permission-upper','cd-permission-space','cd-permission-403','cd-permission-401','cd-permission-404','cd-permission-500','cd-permission-network','cd-permission-invalid-json','cd-permission-wrong-name','cd-permission-no-version','cd-permission-array','cd-permission-redirect','cd-permission-no-http-status','cd-permission-late-false','cd-permission-version-change','cd-permission-before-pull','cd-permission-after-start','cd-permission-after-switch','cd-permission-newer-than-approval','cd-artifact-no-time','cd-artifact-invalid-time','cd-artifact-future','cd-artifact-old'];
function cdFixtureRun(f,scenario){
 const archive=path.join(f.directory,'artifact.zip');fs.writeFileSync(archive,zipRecord(createReleaseRecord(env)));
 const token=path.join(f.secretDirectory,'token');if(!fs.existsSync(token))fs.writeFileSync(token,'fictional_test_token',{mode:0o600});
 return spawnSync('bash',['deploy/cd-check.sh',f.settings,token],{encoding:'utf8',timeout:25000,env:{...process.env,PATH:path.join(f.directory,'bin')+':'+process.env.PATH,SCENARIO:scenario,LOG:f.log,SHA:sha,PAUSED:path.join(f.directory,'paused'),ARTIFACT_ZIP:archive,UPSTREAM_FILE:f.upstream}});
}
for(const scenario of permissionFailures)test(`現在の配信許可と承認期限で拒否する: ${scenario}`,{skip:process.platform==='win32'},()=>{
 const f=fixture(scenario);try{
  const r=cdFixtureRun(f,scenario);assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'current.json'))).container,'old-vinext');
  assert.equal(fs.readFileSync(f.upstream,'utf8'),'proxy_pass http://127.0.0.1:3102;\nset $siteflow_slot green;\n');
  const events=fs.readFileSync(f.log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if(!['cd-permission-after-start','cd-permission-after-switch'].includes(scenario))assert.ok(!events.some(e=>e.tool==='docker'&&['pull','run','stop','rm'].includes(e.args[0])));
  else {assert.ok(events.some(e=>e.tool==='docker'&&e.args[0]==='run'));assert.equal(events.some(e=>e.tool==='nginx'&&e.args[0]==='-s'),scenario==='cd-permission-after-switch');}
 }finally{f.close();}
});
for(const firstScenario of ['cd-success','cd-permission-before-pull'])test(`同じrun/attemptの承認は再配信しない: ${firstScenario}`,{skip:process.platform==='win32'},()=>{
 const f=fixture(firstScenario);try{
  const first=cdFixtureRun(f,firstScenario);assert.equal(first.status===0,firstScenario==='cd-success',first.stdout+first.stderr);
  assert.ok(fs.existsSync(path.join(f.directory,'used-123-a1')));const before=fs.readFileSync(f.log,'utf8');
  const retry=cdFixtureRun(f,'cd-success');assert.equal(retry.status,0,retry.stdout+retry.stderr);assert.match(retry.stdout,/APPROVAL_ALREADY_USED_SKIP/);
  const extra=fs.readFileSync(f.log,'utf8').slice(before.length).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(!extra.some(e=>e.tool==='docker'||e.tool==='nginx'));
 }finally{f.close();}
});
test('期限切れ・許可contextなしでは直接releaseも開始しない',{skip:process.platform==='win32'},()=>{
 const f=fixture('success');try{
  for(const extra of [{SITEFLOW_CD_PERMISSION_VERSION:''},{SITEFLOW_CD_APPROVAL_EXPIRES_EPOCH:'1'}]){const r=f.run(extra);assert.notEqual(r.status,0);}
  const events=fs.existsSync(f.log)?fs.readFileSync(f.log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];assert.ok(!events.some(e=>e.tool==='docker'));
 }finally{f.close();}
});
test('許可APIの応答待ち中に期限を超えた場合も配信しない',{skip:process.platform==='win32'},()=>{
 const f=fixture('success');try{
  fs.writeFileSync(path.join(f.directory,'bin','date'),'#!/bin/sh\nif [ "$*" = "-u +%s" ] && [ -f "$LOG.permission" ]; then exec /bin/date -u -d "+2 hours" +%s; fi\nexec /bin/date "$@"\n',{mode:0o700});
  const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/APPROVAL_EXPIRED_DURING_RELEASE/);
  const events=fs.readFileSync(f.log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);assert.ok(!events.some(e=>e.tool==='docker'||e.tool==='nginx'));
 }finally{f.close();}
});
for(const scenario of ['existing','pull','revision','start','readiness','pause-after-start','pause-after-readiness','nginx-test','reload','https','wrong-route'])test(`失敗時は旧版とDBを維持する: ${scenario}`,{skip:process.platform==='win32'},()=>{
  const f=fixture(scenario);try{
    const r=f.run();assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.equal(fs.readFileSync(f.upstream,'utf8'),'proxy_pass http://127.0.0.1:3102;\nset $siteflow_slot green;\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'current.json'),'utf8')).container,'old-vinext');
    const events=fs.existsSync(f.log)?fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse):[];
    assert.ok(!events.some(e=>e.tool==='docker'&&['stop','volume','compose'].includes(e.args[0])));
    assert.ok(!events.some(e=>e.tool==='docker'&&e.args.includes('old-vinext')));
    if(scenario==='start')assert.ok(events.some(e=>e.tool==='docker'&&e.args[0]==='rm'&&e.args[2]==='d'.repeat(64)));
  }finally{f.close();}
});
for(const disabled of ['enabled','paused','record','state','schema','incident','host-network'])test(`配信前に拒否しコマンドを実行しない: ${disabled}`,{skip:process.platform==='win32'},()=>{
  const f=fixture('success');try{
    if(disabled==='enabled')fs.unlinkSync(path.join(f.directory,'enabled'));
    if(disabled==='paused')fs.writeFileSync(path.join(f.directory,'paused'),'');
    if(disabled==='record')fs.writeFileSync(f.manifest,JSON.stringify({...createReleaseRecord(env),approved:false}));
    if(disabled==='state')fs.unlinkSync(path.join(f.directory,'current.json'));
    if(disabled==='schema')fs.writeFileSync(path.join(f.directory,'schema.json'),'{}');
    if(disabled==='incident')fs.writeFileSync(path.join(f.directory,'incident.json'),'{}');
    if(disabled==='host-network'){const settings=JSON.parse(fs.readFileSync(f.settings,'utf8'));settings.network='host';fs.writeFileSync(f.settings,JSON.stringify(settings));}
    assert.notEqual(f.run().status,0);assert.equal(fs.existsSync(f.log),false);
  }finally{f.close();}
});
test('成功時は旧版を残し、同じ版の再配信は健全性だけを確認する',{skip:process.platform==='win32'},()=>{
  const f=fixture('success');try{
    const r=f.run();assert.equal(r.status,0,r.stdout+r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'current.json'),'utf8')).slot,'blue');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'previous.json'),'utf8')).container,'old-vinext');
    assert.equal(fs.readFileSync(f.upstream,'utf8'),'proxy_pass http://127.0.0.1:3101;\nset $siteflow_slot blue;\n');
    const events=fs.readFileSync(f.log,'utf8');const repeated=f.run();assert.equal(repeated.status,0,repeated.stderr);assert.match(repeated.stdout,/ALREADY_RELEASED_HEALTHY/);
    const extra=fs.readFileSync(f.log,'utf8').slice(events.length).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(extra.some(e=>e.tool==='curl'));
    assert.ok(!extra.some(e=>e.tool==='docker'&&['pull','run','stop','rm'].includes(e.args[0])));
  }finally{f.close();}
});

test('承認されたmigration digestと検証receiptが違えば配信を開始しない',{skip:process.platform==='win32'},()=>{
 const f=fixture('success');try{
  const name=path.join(f.directory,'schema.json');const schema=JSON.parse(fs.readFileSync(name));schema.migrationDigest='sha256:'+'9'.repeat(64);fs.writeFileSync(name,JSON.stringify(schema));
  const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/MIGRATION_RECEIPT_MISMATCH/);assert.equal(fs.existsSync(f.log),false);
 }finally{f.close();}
});

test('migrationイメージが別のGit revisionなら起動前に拒否する',{skip:process.platform==='win32'},()=>{
 const f=fixture('migration-revision');try{
  const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/MIGRATION_IMAGE_REVISION_MISMATCH/);
  const events=fs.readFileSync(f.log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(!events.some(e=>e.tool==='nginx'||(e.tool==='docker'&&['pull','run','stop','rm'].includes(e.args[0]))));
 }finally{f.close();}
});

for(const scenario of ['same-stopped','same-oom','same-image','same-foreign','same-port','same-revision','same-readiness','same-public'])test(`同じ版でも不健全なら成功扱いも自動再起動もしない: ${scenario}`,{skip:process.platform==='win32'},()=>{
 const f=fixture(scenario);try{
  fs.writeFileSync(path.join(f.directory,'current.json'),JSON.stringify({slot:'green',port:3102,container:'siteflow-green-aaaaaaaaaaaa-r123a1',image:'ghcr.io/syucream02/siteflow@'+digest}));
  const result=f.run();assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/ALREADY_RELEASED_HEALTHY/);
  const events=fs.readFileSync(f.log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(!events.some(e=>e.tool==='nginx'||(e.tool==='docker'&&['pull','run','stop','rm'].includes(e.args[0]))));
 }finally{f.close();}
});
test('ロールバックにも失敗した場合は候補を削除しない',{skip:process.platform==='win32'},()=>{
  const f=fixture('rollback-failure');try{
    const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/ROLLBACK_FAILED_KEEP_BOTH_CONTAINERS/);
    assert.ok(!fs.readFileSync(f.log,'utf8').split('\n').filter(Boolean).map(JSON.parse).some(e=>e.tool==='docker'&&e.args[0]==='rm'));
  }finally{f.close();}
});

test('リモートDockerと読み取り公開された秘密設定は配信前に拒否',{skip:process.platform==='win32'},()=>{
  const f=fixture('success');try{
    assert.notEqual(f.run({DOCKER_HOST:'ssh://example.invalid'}).status,0);assert.equal(fs.existsSync(f.log),false);
    fs.chmodSync(path.join(f.directory,'runtime.env'),0o644);
    assert.notEqual(f.run().status,0);assert.equal(fs.existsSync(f.log),false);
  }finally{f.close();}
});
for(const scenario of ['reuse-success','reuse-busy','reuse-foreign'])test(`非公開枠の再利用は所有と接続終了を確認する: ${scenario}`,{skip:process.platform==='win32'},()=>{
  const f=fixture(scenario);try{
    fs.writeFileSync(path.join(f.directory,'previous.json'),JSON.stringify({port:3101,container:'siteflow-blue-cccccccccccc-r100a1',image:'ghcr.io/syucream02/siteflow@sha256:'+'e'.repeat(64)}));
    const result=f.run();assert.equal(result.status===0,scenario==='reuse-success',result.stdout+result.stderr);
    const events=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.some(e=>e.tool==='docker'&&e.args[0]==='stop'),scenario==='reuse-success');
    assert.ok(!events.some(e=>e.tool==='docker'&&e.args.includes('old-vinext')));
  }finally{f.close();}
});
test('初回だけlegacy3002からNext3101へ切り替え、旧版と候補3001には触れない',{skip:process.platform==='win32'},()=>{
 const f=fixture('success');try{
  fs.writeFileSync(path.join(f.directory,'current.json'),JSON.stringify({slot:'legacy',port:3002,container:'old-vinext',image:'old-image'}));
  fs.writeFileSync(f.upstream,'proxy_pass http://127.0.0.1:3002;\nset $siteflow_slot legacy;\n');
  const r=f.run();assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'current.json'),'utf8')).port,3101);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'previous.json'),'utf8')).slot,'legacy');
  const events=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(!events.some(e=>e.tool==='docker'&&e.args[0]==='stop'));
  const started=events.find(e=>e.tool==='docker'&&e.args[0]==='run');
  assert.ok(started.args.includes('127.0.0.1:3101:3000'));assert.ok(started.args.includes('core=0'));assert.ok(started.args.includes('none'));
 }finally{f.close();}
});

test('同時配信は排他ロックで止める',{skip:process.platform==='win32'},async()=>{
  const f=fixture('success');let locker;
  try{
    const marker=path.join(f.directory,'locked');
    locker=spawn('flock',['-x',path.join(f.directory,'release.lock'),'bash','-c','touch "$1"; /bin/sleep 1','--',marker],{stdio:'ignore'});
    const exited=new Promise(resolve=>locker.once('close',resolve));
    for(let i=0;i<100&&!fs.existsSync(marker);i++)await new Promise(r=>setTimeout(r,5));
    assert.ok(fs.existsSync(marker));const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/RELEASE_BUSY/);assert.equal(fs.existsSync(f.log),false);
    await exited;
  }finally{locker?.kill();f.close();}
});
