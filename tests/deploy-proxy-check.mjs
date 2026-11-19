// 実Nginx・実Next.js・TLS MySQLで切替を確認。docker CLIだけをプロセス起動の代役にする。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createReleaseRecord } from '../deploy/release-record.mjs';

assert.equal(process.platform,'linux');
assert.equal(process.env.SITEFLOW_LOCAL_PROXY_TEST_APPROVED,'yes');
const receipt=JSON.parse(process.env.SITEFLOW_MIGRATION_RECEIPT);
assert.match(receipt.databaseName,/^siteflow_public_tls_[a-f0-9]{12}$/);
assert.equal(process.env.SITEFLOW_DB_NAME,receipt.databaseName);
assert.equal(process.env.SITEFLOW_DB_HOST,'mysql.siteflow.test');
assert.equal(process.env.SITEFLOW_DB_PASSWORD,undefined);
assert.equal(process.env.SITEFLOW_AUTH_SECRET,undefined);
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>8192)throw Error('FIXTURE_INPUT_TOO_LARGE');}
const credentials=JSON.parse(input);input='';
assert.match(credentials.password,/^[a-f0-9]{48}$/);assert.match(credentials.authSecret,/^[a-f0-9]{64}$/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'siteflow-proxy-check-'));
const bin=path.join(root,'bin');fs.mkdirSync(bin);
const upstream=path.join(root,'upstream.inc'), cert=path.join(root,'https.pem'), key=path.join(root,'https.key');
const sha='a'.repeat(40), digest='sha256:'+'b'.repeat(64);
const secretDirectory=path.join('/srv/siteflow-mysql',path.basename(root));fs.mkdirSync(secretDirectory,{recursive:true,mode:0o700});
fs.chownSync(secretDirectory,1000,1000);
const releaseToken=path.join(secretDirectory,'release-token');fs.writeFileSync(releaseToken,'fictional_test_token',{mode:0o600});
const dbPasswordFile=path.join(secretDirectory,'db-password'),authSecretFile=path.join(secretDirectory,'auth-secret');
for(const[file,value]of [[dbPasswordFile,credentials.password],[authSecretFile,credentials.authSecret]]){fs.writeFileSync(file,value+'\n',{mode:0o400,flag:'wx'});fs.chownSync(file,1000,1000);}
credentials.password='';credentials.authSecret='';
process.env.SITEFLOW_DB_PASSWORD_FILE=dbPasswordFile;process.env.SITEFLOW_AUTH_SECRET_FILE=authSecretFile;
fs.writeFileSync(path.join(root,'schema.json'),JSON.stringify(receipt));
const environment={SITEFLOW_RELEASE_ENABLED:'true',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'syucream02/siteflow',GITHUB_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',SITEFLOW_IMAGE_DIGEST:digest,SITEFLOW_MIGRATION_DIGEST:receipt.migrationDigest,SITEFLOW_SCHEMA_HASH:receipt.schemaHash};
const manifest=path.join(root,'manifest.json');fs.writeFileSync(manifest,JSON.stringify(createReleaseRecord(environment)));
const settings=path.join(root,'settings.json');fs.writeFileSync(settings,JSON.stringify({stateDirectory:root,upstreamFile:upstream,runtimeEnvFile:path.join(root,'runtime.env'),caFile:'/run/siteflow/ca.pem',network:'local-fixture',publicOrigin:'https://siteflow.test',readinessAttempts:3,databaseName:receipt.databaseName,databaseHost:receipt.databaseHost,databasePasswordFile:dbPasswordFile,authSecretFile,dataMount:'/srv/siteflow-mysql',dataFsUuid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',dataEbsVolumeId:'vol-aaaaaaaaaaaaaaaaa'}));
fs.writeFileSync(path.join(root,'runtime.env'),'SITEFLOW_DB_USER='+process.env.SITEFLOW_DB_USER+'\nSITEFLOW_DB_PASSWORD_FILE=/run/secrets/db-password\nSITEFLOW_AUTH_SECRET_FILE=/run/secrets/auth-secret\n',{mode:0o600});
// EBS hardware is a local fixture only. The production guard itself is unchanged.
for(const name of ['mountpoint','findmnt','lsblk'])fs.writeFileSync(path.join(bin,name),`#!/usr/bin/env node\nconst a=process.argv.slice(2);if('${name}'==='mountpoint')process.exit(0);if('${name}'==='lsblk')console.log('volaaaaaaaaaaaaaaaaa');else console.log(a.at(-1)==='UUID'?'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa':a.at(-1)==='FSTYPE'?'xfs':'/dev/nvme1n1');\n`,{mode:0o700});
fs.writeFileSync(path.join(root,'enabled'),'');
const pidFile=path.join(root,'candidate.pid');
const docker=`#!/usr/bin/env node
const fs=require('node:fs'), cp=require('node:child_process');const a=process.argv.slice(2);const pidFile=process.env.PROXY_PID_FILE;
if(a[0]==='context'){console.log('unix:///var/run/docker.sock');process.exit(0);}
if(a[0]==='container')process.exit(fs.existsSync(pidFile)?0:1);
if(a[0]==='image')console.log('a'.repeat(40));
if(a[0]==='run'){
 const binding=a[a.indexOf('--publish')+1];if(!/^127[.]0[.]0[.]1:310[12]:3000$/.test(binding))process.exit(1);
 const env={...process.env,HOSTNAME:'127.0.0.1',PORT:binding.split(':')[1],SITEFLOW_WORKSPACE_MODE:'public-integrated',SITEFLOW_PUBLIC_ORIGIN:'https://siteflow.test',SITEFLOW_DB_CA_FILE:'/run/siteflow/ca.pem'};
 if(process.env.PROXY_SCENARIO==='invalid-settings')env.SITEFLOW_AUTH_SECRET='';
 const child=cp.spawn(process.execPath,['/runtime/server.js'],{cwd:'/runtime',env,detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(pidFile,String(child.pid));
 const id='d'.repeat(64);fs.writeFileSync(a[a.indexOf('--cidfile')+1],id);console.log(id);
}
if(a[0]==='rm'&&fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM')}catch{}fs.unlinkSync(pidFile);}
`;
fs.writeFileSync(path.join(bin,'docker'),docker,{mode:0o700});
fs.writeFileSync(path.join(bin,'curl'),`#!/bin/sh
for value in "$@"; do case "$value" in https://api.github.com/*/variables/SITEFLOW_RELEASE_ENABLED) printf '%s\\n' '{"name":"SITEFLOW_RELEASE_ENABLED","value":"true","updated_at":"2026-01-01T00:00:00Z"}' '200'; exit 0;; esac; done
if [ "$PROXY_SCENARIO" = public-failure ]; then for value in "$@"; do case "$value" in https:*/api/ready) exit 22;; esac; done; fi
exec /usr/bin/curl --noproxy '*' --resolve siteflow.test:443:127.0.0.1 --cacert '${cert}' "$@"
`,{mode:0o700});
const nginxConfig=path.join(root,'nginx.conf');
fs.writeFileSync(path.join(bin,'nginx'),`#!/bin/sh\nexec /usr/sbin/nginx -c '${nginxConfig}' "$@"\n`,{mode:0o700});
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=siteflow.test','-addext','subjectAltName=DNS:siteflow.test'],{stdio:'ignore'});
fs.writeFileSync(nginxConfig,`pid ${root}/nginx.pid;
error_log ${root}/nginx-error.log;
events { worker_connections 64; }
http { access_log off; server { listen 443 ssl; server_name siteflow.test;
ssl_certificate ${cert}; ssl_certificate_key ${key};
add_header X-SiteFlow-Slot $siteflow_slot always;
add_header X-Content-Type-Options nosniff always;
proxy_hide_header X-SiteFlow-Slot;
location / { proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; include ${upstream}; }
} }
`);
const old=http.createServer((_q,r)=>{r.setHeader('Content-Type','text/plain');r.end('OLD_VERSION');});
const request=()=>new Promise((resolve,reject)=>{https.get({host:'127.0.0.1',port:443,path:'/api/ready',servername:'siteflow.test',headers:{Host:'siteflow.test'},ca:fs.readFileSync(cert),agent:false},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>resolve({status:r.statusCode,text,headers:r.headers}));}).on('error',reject);});
const checks=[];
const reset=async()=>{
  if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM');}catch{/* 終了済み */}fs.unlinkSync(pidFile);await new Promise(r=>setTimeout(r,500));}
  fs.writeFileSync(upstream,'proxy_pass http://127.0.0.1:3002;\nset $siteflow_slot legacy;\n');
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({slot:'legacy',port:3002,image:'old-image',container:'old-fixture'}));
};
const run=scenario=>new Promise((resolve,reject)=>{
  const child=spawn('bash',['deploy/release.sh',manifest,settings,releaseToken],{env:{...process.env,SITEFLOW_CD_PERMISSION_VERSION:'2026-01-01T00:00:00Z',SITEFLOW_CD_APPROVAL_EXPIRES_EPOCH:String(Math.floor(Date.now()/1000)+3600),PATH:bin+':'+process.env.PATH,PROXY_SCENARIO:scenario,PROXY_PID_FILE:pidFile},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('LOCAL_RELEASE_TIMEOUT'));},60000);
  child.once('close',code=>{clearTimeout(timer);resolve({code,output});});child.once('error',reject);
});
try{
  await new Promise(r=>old.listen(3002,'127.0.0.1',r));await reset();
  execFileSync('/usr/sbin/nginx',['-c',nginxConfig]);
  assert.equal((await request()).text,'OLD_VERSION');
  const success=await run('success');assert.equal(success.code,0,success.output);
  const published=await request();assert.equal(published.text,'{"ok":true}');assert.equal(published.headers['x-content-type-options'],'nosniff');
  checks.push('実Nginx HTTPSから実Next.jsのreadinessへ切替成功（DBは実TLS接続）');
  for(const scenario of ['invalid-settings','public-failure']){
    await reset();execFileSync('/usr/sbin/nginx',['-c',nginxConfig,'-s','reload']);await new Promise(r=>setTimeout(r,300));
    const result=await run(scenario);assert.notEqual(result.code,0,result.output);
    assert.equal((await request()).text,'OLD_VERSION');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8')).slot,'legacy');
    checks.push(scenario==='invalid-settings'?'候補の設定不足では転送先を変更しない':'切替後のHTTPS失敗では実Nginxを旧転送先へ戻す');
  }
  console.log(JSON.stringify({passed:true,checks,fileSecrets:true,scope:'real Nginx/Next.js/TLS MySQL; Docker process adapter and EBS identity are simulated; old endpoint is a fixture, not real Vinext'}));
} finally{
  await reset();
  try{execFileSync('/usr/sbin/nginx',['-c',nginxConfig,'-s','quit'],{stdio:'ignore'});}catch{/* 未起動 */}
  old.closeAllConnections();await new Promise(r=>old.close(r));
  if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('siteflow-proxy-check-'))throw Error('INVALID_TEMP_PATH');
  fs.rmSync(root,{recursive:true,force:true});
  assert.equal(path.dirname(path.resolve(secretDirectory)),'/srv/siteflow-mysql');assert.ok(path.basename(secretDirectory).startsWith('siteflow-proxy-check-'));fs.rmSync(secretDirectory,{recursive:true,force:true});
}
