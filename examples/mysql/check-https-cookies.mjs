import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { fromNodeHeaders } from 'better-auth/node';
import { readSchemaCheckSettings } from './schema-check-settings.mjs';
import { createLocalWorkspaceData, removeLocalWorkspaceData } from './local-workspace-data.ts';
import { startApiServer } from './api-server.ts';
import { proxyPublicApi } from '../../lib/siteflow/public-api-proxy.ts';
import { publicResponseCookie } from '../../lib/siteflow/public-cookies.ts';
import { createTlsMysqlFixture } from './tls-mysql-fixture.mjs';

const dockerPublic=process.argv.includes('--docker-public');
const integratedPublic=process.argv.includes('--integrated-public')||dockerPublic;
const nextMode=process.argv.includes('--next-workspace')||integratedPublic;
const output=fileURLToPath(new URL(dockerPublic?'../../work/docker-public-check/':integratedPublic?'../../work/public-integrated-check/':nextMode?'../../work/next-preview-check/':'../../work/https-cookie-preview/',import.meta.url));fs.mkdirSync(output,{recursive:true});
fs.rmSync(path.join(output,'results.json'),{force:true});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'siteflow-https-cookies-'));
const profile=path.join(temporary,'chrome');fs.mkdirSync(profile);
let prisma,data,api,tlsServer,plainServer,child,nextChild,nextPort,ws,send,origin,tlsFixture,phase='setup';
let tlsProtocol='',crossOriginStatus=null,crossOriginHadCookie=false,httpObserved=false,httpHadAuthCookie=false,authenticatedRequests=0;
let succeeded=false;
const checks=[];
const docker=process.platform==='win32'?path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe'):'docker';
const dockerCall=args=>execFileSync(docker,args,{encoding:'utf8',stdio:'pipe',windowsHide:true,timeout:30000});
const checkResource='siteflow-docker-check-'+randomBytes(6).toString('hex');
let appContainer,networkCreated=false,volumeCreated=false;
const measurements=[];
// NodeのfetchはHostの上書きを反映しない版がある。Host試験はhttp.requestで送る。
const hostStatus=route=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:nextPort,path:route,headers:{Host:new URL(origin).host,'x-forwarded-proto':'https'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
  req.setTimeout(15000,()=>req.destroy(Error('NEXT_PROBE_TIMEOUT')));req.once('error',reject);req.end();
});
const nextStatuses=[];
const hasSession=value=>/(?:^|;\s*)__Secure-better-auth\.session_token=/.test(value??'');
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address().port);});});
const close=async server=>{if(server?.listening){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
const stopNext=async()=>{if(appContainer){dockerCall(['rm','--force',appContainer]);appContainer=undefined;}if(nextChild&&nextChild.exitCode===null){const processToStop=nextChild;await new Promise(resolve=>{processToStop.once('exit',resolve);processToStop.kill();});}nextChild=undefined;};
const startNext=async(mode,overrides={})=>{
  await stopNext();
  if(!nextPort){const probe=http.createServer();nextPort=await listen(probe);await close(probe);}
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const publicMode=integratedPublic?'public-integrated':'public';
  const env={...process.env,...tlsFixture?.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',SITEFLOW_WORKSPACE_MODE:mode==='public'?publicMode:mode,SITEFLOW_PUBLIC_ORIGIN:origin,SITEFLOW_PUBLIC_API_ORIGIN:mode==='public'&&!integratedPublic?api.origin:'',...overrides};
  if(mode==='invalid'){env.SITEFLOW_WORKSPACE_MODE=publicMode;if(integratedPublic)env.SITEFLOW_AUTH_SECRET='';}
  if(dockerPublic){
    env.SITEFLOW_DB_HOST='mysql.siteflow.test';env.SITEFLOW_DB_PORT='3306';
    env.SITEFLOW_DB_CA_FILE=overrides.SITEFLOW_DB_CA_FILE?'/run/siteflow/wrong-ca.pem':'/run/siteflow/ca.pem';
    const keys=[...Object.keys(tlsFixture.env),'SITEFLOW_WORKSPACE_MODE'];
    const cidFile=path.join(temporary,'app.id');fs.rmSync(cidFile,{force:true});
    const args=['run','--detach','--pull=never','--cidfile',cidFile,'--name',checkResource+'-app','--label','siteflow.check=docker-public','--network',checkResource,'--publish','127.0.0.1::3000','--memory','384m','--memory-swap','384m','--mount',`type=bind,source=${tlsFixture.env.SITEFLOW_DB_CA_FILE},target=/run/siteflow/ca.pem,readonly`,'--mount',`type=bind,source=${tlsFixture.wrongCaFile},target=/run/siteflow/wrong-ca.pem,readonly`,...keys.flatMap(k=>['--env',k]),process.env.SITEFLOW_DOCKER_IMAGE??'siteflow:docker-check-20261116'];
    try{appContainer=execFileSync(docker,args,{env,encoding:'utf8',stdio:'pipe',windowsHide:true,timeout:30000}).trim();}
    finally{if(!appContainer&&fs.existsSync(cidFile))appContainer=fs.readFileSync(cidFile,'utf8').trim();}
    if(!/^[a-f0-9]{64}$/.test(appContainer??''))throw Error('INVALID_APP_CONTAINER');
    const binding=dockerCall(['port',appContainer,'3000/tcp']).trim();
    if(!/^127\.0\.0\.1:[0-9]+$/.test(binding))throw Error('NONLOCAL_APP_BINDING');
    nextPort=Number(binding.split(':')[1]);
  }else nextChild=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(nextPort)],{cwd:root,env,windowsHide:true,stdio:'ignore'});
  for(let i=0;i<200;i++){
    if(nextChild&&nextChild.exitCode!==null)throw Error('NEXT_START_FAILED');
    try{if((await fetch(`http://127.0.0.1:${nextPort}/api/health`,{signal:AbortSignal.timeout(1000)})).ok)return;}catch{/* 起動完了まで待つ。 */}
    await new Promise(r=>setTimeout(r,100));
  }throw Error('NEXT_START_TIMEOUT');
};
const page=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteFlow HTTPS検証</title>
<style>body{margin:0;background:#f3f6f3;color:#203c35;font:16px/1.9 Arial,Meiryo,sans-serif}main{max-width:620px;margin:48px auto;padding:28px}section{background:white;border:1px solid #d5e1d9;border-radius:16px;padding:26px}h1{font-size:26px;line-height:1.5}small{color:#52665a}label{display:block;margin:14px 0}input{display:block;box-sizing:border-box;max-width:100%;width:100%;padding:12px;font:inherit;border:1px solid #b8ccbe;border-radius:8px}button{padding:12px 20px;font:inherit;border:1px solid #286d50;background:#286d50;color:white;border-radius:8px;margin:8px 0;cursor:pointer}#state{padding:16px;background:#e8f1e8;border-radius:8px}p{overflow-wrap:anywhere}button:focus-visible{outline:3px solid #286d50;outline-offset:4px}@media(max-width:650px){main{margin:14px auto;padding:18px}section{padding:20px}}[hidden]{display:none!important}</style>
<main><small>検証専用 / PC内のHTTPS</small><h1>Cookieの動きを確認</h1><section><p id="state" role="status">確認中</p><form id="login"><label for="email">検証用メール<input id="email" type="email" required></label><label for="password">検証用パスワード<input id="password" type="password" required></label><button>ログイン</button></form><button id="logout" hidden>ログアウト</button><p>この画面は検証用です。案件アプリの公開画面ではありません。</p></section><p><small>証明書・ブラウザー・データは今回の検証専用です。</small></p></main>
<script>
window.probe=async(path,options={})=>{const r=await fetch('/api/siteflow/'+path,{credentials:'same-origin',...options});const data=await r.json();return {status:r.status,userId:data?.user?.id??null};};
const state=document.getElementById('state'),login=document.getElementById('login'),logout=document.getElementById('logout');
window.refresh=async()=>{const session=await probe('auth/get-session');const yes=!!session.userId;state.textContent=yes?'ログイン中：HTTPSのCookieで確認できました':'ログアウト済み：ログイン情報はありません';login.hidden=yes;logout.hidden=!yes;return session;};
login.onsubmit=async event=>{event.preventDefault();const result=await probe('auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value})});document.getElementById('email').value='';document.getElementById('password').value='';if(result.status===200)await refresh();else state.textContent='検証用のログインに失敗しました';};
logout.onclick=async()=>{await probe('auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await refresh();};
refresh();
</script></html>`;
try {
  if(dockerPublic){
    // fixture側のローカルDocker確認を先に実施し、外部Dockerへリソースを作らない。
    const endpoint=dockerCall(['context','inspect','--format','{{.Endpoints.docker.Host}}']).trim();
    const {isLocalDockerEndpoint}=await import('./backup-check-settings.mjs');
    if(!isLocalDockerEndpoint(endpoint,process.platform)||(process.env.DOCKER_HOST&&!isLocalDockerEndpoint(process.env.DOCKER_HOST,process.platform)))throw Error('REMOTE_DOCKER_NOT_ALLOWED');
    dockerCall(['network','create','--label','siteflow.check=docker-public',checkResource]);networkCreated=true;
    dockerCall(['volume','create','--label','siteflow.check=docker-public',checkResource]);volumeCreated=true;
  }
  if(integratedPublic){phase='mysql-tls-fixture';tlsFixture=await createTlsMysqlFixture(dockerPublic?{networkName:checkResource,volumeName:checkResource}:{});prisma=tlsFixture.prisma;checks.push(...tlsFixture.checks);}
  else{const settings=readSchemaCheckSettings();prisma=new PrismaClient({adapter:new PrismaMariaDb({host:'127.0.0.1',port:settings.port,user:settings.user,password:settings.password,database:settings.database,connectionLimit:2})});}
  const certPath=path.join(temporary,'certificate.pem'),keyPath=path.join(temporary,'private.key');
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=siteflow.test','-addext','subjectAltName=DNS:siteflow.test,DNS:other.siteflow.test'],{stdio:'ignore',windowsHide:true});
  const cert=fs.readFileSync(certPath);const pin=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
  data=await createLocalWorkspaceData(prisma);
  tlsServer=https.createServer({key:fs.readFileSync(keyPath),cert,minVersion:'TLSv1.2'},async(req,res)=>{
    try {
      tlsProtocol=req.socket.getProtocol();const url=new URL(req.url,origin);
      res.setHeader('Cache-Control','no-store');
      if(nextMode){
        const headers={...req.headers,'x-forwarded-proto':'https'};
        delete headers['x-forwarded-host'];delete headers['x-forwarded-for'];delete headers['x-forwarded-port'];
        const upstream=http.request({hostname:'127.0.0.1',port:nextPort,path:req.url,method:req.method,headers},incoming=>{if(req.url.startsWith('/api/siteflow/'))nextStatuses.push(incoming.statusCode);res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});
        upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('NEXT_CHECK_FAILED');});req.pipe(upstream);return;
      }
      if(url.pathname.startsWith('/api/siteflow/')&&url.pathname!=='/api/siteflow/browser-page'){
        if(hasSession(req.headers.cookie))authenticatedRequests++;
        const writing=!['GET','HEAD'].includes(req.method);
        const request=new Request(origin+req.url,{method:req.method,headers:fromNodeHeaders(req.headers),...(writing?{body:Readable.toWeb(req),duplex:'half'}:{})});
        const response=await proxyPublicApi(request,url.pathname.slice('/api/siteflow/'.length).split('/'),{enabled:true,publicOrigin:origin,backendOrigin:api.origin});
        if(req.headers.origin&&req.headers.origin!==origin){crossOriginStatus=response.status;crossOriginHadCookie=hasSession(req.headers.cookie);}
        res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Cookie','Set-Cookie':response.headers.getSetCookie()});res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      if(url.pathname==='/fixture/host-cookies'){
        const attributes='Path=/; Secure; HttpOnly; SameSite=Lax';
        res.setHeader('Set-Cookie',[publicResponseCookie('__Host-better-auth.fixture=marker; '+attributes),'__Host-better-auth.invalid=marker; Path=/api/siteflow; Secure; HttpOnly; SameSite=Lax']);res.end('{}');return;
      }
      if(url.pathname==='/fixture/clear'){
        res.setHeader('Set-Cookie',publicResponseCookie('__Host-better-auth.fixture=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax'));res.end('{}');return;
      }
      if(url.pathname==='/fixture/readable-cookie'||url.pathname==='/fixture/readable-clear'){
        res.setHeader('Set-Cookie','siteflow_readable=marker; Path=/api/siteflow; Secure; SameSite=Lax'+(url.pathname.endsWith('clear')?'; Max-Age=0':''));res.end('{}');return;
      }
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(page);
    }catch{if(!res.headersSent)res.writeHead(500);res.end('HTTPS_CHECK_FAILED');}
  });
  const port=await listen(tlsServer);origin=`https://siteflow.test:${port}`;
  if(!integratedPublic){const apiSettings=readSchemaCheckSettings();const apiPrisma=new PrismaClient({adapter:new PrismaMariaDb({host:'127.0.0.1',port:apiSettings.port,user:apiSettings.user,password:apiSettings.password,database:apiSettings.database,connectionLimit:2})});api=await startApiServer({prisma:apiPrisma,authSecret:randomBytes(32).toString('hex'),publicOrigin:origin,secureCookies:true,port:0});}
  if(nextMode){
    phase='disabled';await startNext('disabled');
    assert.equal((await fetch(`http://127.0.0.1:${nextPort}/api/siteflow/auth/get-session`)).status,404);
    assert.ok(!(await(await fetch(`http://127.0.0.1:${nextPort}/workspace`)).text()).includes('id="login-email"'));checks.push('Production disabled mode closes both workspace and API');
    phase='invalid';await startNext('invalid');
    assert.equal((await fetch(`http://127.0.0.1:${nextPort}/api/siteflow/auth/get-session`)).status,503);
    assert.ok(!(await(await fetch(`http://127.0.0.1:${nextPort}/workspace`)).text()).includes('id="login-email"'));checks.push('Invalid public configuration stays closed with no local fallback');
    phase='public';await startNext('public');
    assert.equal((await fetch(`http://127.0.0.1:${nextPort}/api/siteflow/auth/get-session`)).status,403);
    assert.ok(!(await(await fetch(`http://127.0.0.1:${nextPort}/workspace`)).text()).includes('id="login-email"'));checks.push('Valid public mode still rejects the wrong Host for page and API');
    if(dockerPublic)assert.equal(await hostStatus('/api/siteflow/auth/get-session'),200);
  }
  plainServer=http.createServer((req,res)=>{if(req.url.startsWith('/api/siteflow/')){httpObserved=true;httpHadAuthCookie=hasSession(req.headers.cookie);}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end('<p id="http-probe">HTTP probe</p>');});
  const plainPort=await listen(plainServer);
  child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--disable-background-networking','--no-proxy-server','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--ignore-certificate-errors-spki-list=${pin}`,'--host-resolver-rules=MAP siteflow.test 127.0.0.1, MAP other.siteflow.test 127.0.0.1','about:blank'],{windowsHide:true,stdio:'ignore'});
  let chromePort;for(let i=0;i<100;i++){try{chromePort=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(chromePort,'Chrome startup');
  const pages=await(await fetch(`http://127.0.0.1:${chromePort}/json`)).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});let next=0;const pending=new Map();
  send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error('CDP_FAILED'));else p.resolve(m.result);}};
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('BROWSER_EVALUATION_FAILED');return r.result.value;};
  const wait=async(expression,label)=>{for(let i=0;i<120;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('TIMEOUT_'+label);};
  const navigate=async url=>{await send('Page.navigate',{url});await wait(nextMode?`location.href===${JSON.stringify(url)} && document.readyState==='complete'`:'!!window.probe','PAGE');};
  const sessionCookies=async()=>{const r=await send('Network.getCookies',{urls:[origin+'/api/siteflow/auth/get-session']});return r.cookies.filter(c=>c.name==='__Secure-better-auth.session_token');};
  await send('Page.enable');await send('Network.enable');
  if(nextMode){
    const click=async text=>{await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`,'BUTTON');await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);};
    const fill=async(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const selectTeam=async value=>{await wait('!!document.getElementById("team-select")','TEAM');await evaluate(`(()=>{const e=document.getElementById('team-select');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
    phase='next-login-form';await navigate(origin+'/workspace');await wait('!!document.getElementById("login-email")','LOGIN_FORM');assert.equal(await evaluate('isSecureContext'),true);assert.equal(await evaluate("document.body.textContent.includes('WORKSPACE PREVIEW')"),true);
    phase='next-login-submit';await fill('#login-email',data.email);await fill('#login-password',data.password);await click('ログイン');await wait('!!document.getElementById("team-select")','SIGNED_IN');
    const cookies=await sessionCookies();assert.equal(cookies.length,1);assert.equal(cookies[0].secure,true);assert.equal(cookies[0].httpOnly,true);assert.equal(cookies[0].path,'/api/siteflow');checks.push('Built Next.js workspace logs in over HTTPS through the real route and stores Secure HttpOnly cookie');
    await selectTeam(data.teamIds[0]);await wait('document.querySelectorAll("[data-project-id]").length===20','PROJECTS');
    phase='next-create';await click('新しい案件を登録');await wait('!!document.getElementById("project-name")','CREATE');await fill('#project-name','架空のHTTPS確認案件');await fill('#project-code','NEXT-HTTPS-QA');await fill('#project-due','2026-01-01');
    await wait(`!!document.querySelector('#project-primary option[value="${data.userId}"]')`,'PRIMARY');await evaluate(`(()=>{const e=document.getElementById('project-primary');e.value=${JSON.stringify(data.userId)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('案件を登録する');await wait('!!document.querySelector("[data-project-detail] dl")','CREATED');
    const created=await prisma.project.findFirstOrThrow({where:{teamId:data.teamIds[0],code:'NEXT-HTTPS-QA'}});await click('基本情報を編集');await wait('!!document.getElementById("edit-clientName")','EDIT');await fill('#edit-clientName','架空のHTTPS取引先');await click('変更を保存する');await wait('!document.querySelector("[data-project-editor]") && !!document.querySelector("[data-project-detail] dl")','EDITED');
    assert.equal((await prisma.project.findUniqueOrThrow({where:{id:created.id}})).clientName,'架空のHTTPS取引先');checks.push('Actual Next.js UI creates and edits a case with DB persistence through the public proxy');
    phase='next-reload';await selectTeam(data.teamIds[1]);await wait("document.body.textContent.includes('このチームの案件はまだありません')",'EMPTY_TEAM');assert.equal(await evaluate(`!!document.querySelector('[data-project-id="${created.id}"]')`),false);
    await send('Page.reload',{ignoreCache:true});await wait('!!document.getElementById("team-select")','RELOAD_SESSION');await selectTeam(data.teamIds[0]);await wait(`!!document.querySelector('[data-project-id="${created.id}"]')`,'RELOAD_ROW');await evaluate(`document.querySelector('[data-project-id="${created.id}"] button').click()`);await wait("document.body.textContent.includes('架空のHTTPS取引先')",'RELOAD_SAVED');checks.push('Team switch does not mix rows; reload retains login and saved case');
    if(integratedPublic){
      phase='integrated-restart';await startNext('public');
      assert.equal((await evaluate("fetch('/api/siteflow/auth/get-session').then(r=>r.json())")).user.id,data.userId);
      checks.push('固定secretと同じDBでNext.jsを再起動してもブラウザーのセッションを維持');
      phase='integrated-wrong-ca';await startNext('public',{SITEFLOW_DB_CA_FILE:tlsFixture.wrongCaFile});
      const unavailable=await evaluate("fetch('/api/siteflow/auth/get-session').then(async r=>({status:r.status,body:await r.text()}))");
      assert.equal(unavailable.status,503);assert.ok(!unavailable.body.includes(tlsFixture.env.SITEFLOW_DB_PASSWORD));assert.ok(!unavailable.body.includes(tlsFixture.wrongCaFile));
      if(dockerPublic)assert.equal(await hostStatus('/api/ready'),503);
      await startNext('public');assert.equal((await evaluate("fetch('/api/siteflow/auth/get-session').then(r=>r.json())")).user.id,data.userId);
      checks.push('実Next.jsでも異なるDB用CAは503になり、秘密情報を返さず正しい設定で復帰');
    }
    if(dockerPublic){
      phase='docker-readiness';
      assert.equal(await hostStatus('/api/ready'),200);
      assert.equal((await fetch(`http://127.0.0.1:${nextPort}/api/ready`)).status,503);
      checks.push('DBと会議テーブルのreadinessが200、想定外Hostは503');
      const browserApi=async(route,method='GET',body)=>evaluate(`fetch('/api/siteflow/'+${JSON.stringify(route)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},${body===undefined?'':`body:${JSON.stringify(JSON.stringify(body))},`}}).then(async r=>({status:r.status,data:await r.json()}))`);
      phase='docker-meeting';
      const meeting=await browserApi(`teams/${data.teamIds[0]}/meetings`,'POST',{});
      assert.equal(meeting.status,201);
      const meetingId=meeting.data.meeting?.id??meeting.data.id;
      assert.ok(meetingId);
      const meetingPath=`teams/${data.teamIds[0]}/meetings/${meetingId}`;
      const detail=await browserApi(meetingPath);
      assert.equal(detail.status,200);assert.equal(detail.data.meeting.counts.total,22);
      const entryId=detail.data.meeting.entries[0].id;
      for(const [action,expectedVersion] of [['confirm',1],['unconfirm',2],['confirm',3]]){
        assert.equal((await browserApi(meetingPath,'PATCH',{action,expectedVersion,entryId})).status,200);
      }
      assert.equal((await browserApi(meetingPath,'PATCH',{action:'finish',expectedVersion:4,allowUnconfirmed:false})).status,409);
      assert.equal((await browserApi(meetingPath,'PATCH',{action:'finish',expectedVersion:4,allowUnconfirmed:true})).status,200);
      assert.equal((await browserApi(meetingPath,'PATCH',{action:'confirm',expectedVersion:5,entryId})).status,409);
      checks.push('Docker内APIで22案件の会議開始・確認・取消・再確認・終了と終了後更新拒否を確認');
      measurements.push(JSON.parse(dockerCall(['stats','--no-stream','--format','{{json .}}',appContainer])),JSON.parse(dockerCall(['stats','--no-stream','--format','{{json .}}',tlsFixture.mysqlId()])));
      await stopNext();await tlsFixture.recreate();await startNext('public');
      assert.equal((await evaluate("fetch('/api/siteflow/auth/get-session').then(r=>r.json())")).user.id,data.userId);
      assert.equal((await prisma.project.findUniqueOrThrow({where:{id:created.id}})).clientName,'架空のHTTPS取引先');
      assert.ok(await prisma.meeting.findUnique({where:{id:meetingId}}));
      checks.push('Next.jsとMySQLコンテナを再作成し、名前付きvolumeから案件・会議・セッションを維持');
    }
    phase='next-layout';for(const width of [1440,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,`next-workspace-${width}.png`),Buffer.from(shot.data,'base64'));}checks.push('Actual Next.js workspace detail fits 1440/390 and screenshots contain only fake data');
    phase='next-logout';await click('ログアウト');await wait('!!document.getElementById("login-email")','LOGOUT');assert.equal((await sessionCookies()).length,0);await send('Page.reload',{ignoreCache:true});await wait('!!document.getElementById("login-email")','LOGOUT_RELOAD');assert.equal(await evaluate("fetch('/api/siteflow/teams').then(r=>r.status)"),401);assert.equal(await prisma.session.count({where:{userId:data.userId}}),0);checks.push('Next.js logout removes browser/DB session and reload remains logged out');
    await navigate(origin+'/');assert.equal(await evaluate("document.body.textContent.includes('SiteFlow')"),true);checks.push('Existing root demo is still served by the same production build');
  }else{
  await navigate(origin);
  phase='tls';assert.equal(await evaluate('isSecureContext'),true);assert.ok(/^TLSv1\.[23]$/.test(tlsProtocol));const beforeLogin=await evaluate("probe('auth/get-session')");assert.equal(beforeLogin.status,200);assert.equal(beforeLogin.userId,null);checks.push('TLS connection and secure browser context; unauthenticated session');
  phase='cookie-prefix';await evaluate("fetch('/fixture/host-cookies').then(r=>r.text())");const prefixCookies=(await send('Network.getCookies',{urls:[origin+'/api/siteflow/']})).cookies;assert.ok(prefixCookies.some(c=>c.name==='__Host-better-auth.fixture'&&c.path==='/'));assert.ok(!prefixCookies.some(c=>c.name==='__Host-better-auth.invalid'));await evaluate("fetch('/fixture/clear').then(r=>r.text())");checks.push('Browser accepts root __Host cookie, rejects wrong Path, and deletes fixture');
  phase='login';await evaluate(`(()=>{document.getElementById('email').value=${JSON.stringify(data.email)};document.getElementById('password').value=${JSON.stringify(data.password)};document.getElementById('login').requestSubmit();})()`);await wait("document.getElementById('logout').hidden===false",'LOGIN');
  const saved=await sessionCookies();assert.equal(saved.length,1);assert.equal(saved[0].secure,true);assert.equal(saved[0].httpOnly,true);assert.equal(saved[0].sameSite,'Lax');assert.equal(saved[0].path,'/api/siteflow');assert.equal(saved[0].domain,'siteflow.test');
  await evaluate("fetch('/fixture/readable-cookie').then(r=>r.text())");await navigate(origin+'/api/siteflow/browser-page');assert.equal(await evaluate("document.cookie.includes('siteflow_readable=marker')"),true);assert.equal(await evaluate("document.cookie.includes('better-auth')"),false);await evaluate("fetch('/fixture/readable-clear').then(r=>r.text())");checks.push('Browser stores Secure/HttpOnly/Lax host-only session cookie; JavaScript on matching Path reads control cookie but cannot read session');
  phase='reload';await send('Page.reload',{ignoreCache:true});await wait('!!window.probe','RELOAD');assert.equal((await evaluate("probe('auth/get-session')")).userId,data.userId);assert.equal((await evaluate("probe('teams')")).status,200);assert.ok(authenticatedRequests>0);checks.push('Reload and API fetch automatically send cookie without manual Cookie headers');
  phase='http';await send('Page.navigate',{url:`http://siteflow.test:${plainPort}/api/siteflow/probe`});await wait("!!document.getElementById('http-probe')",'HTTP');assert.equal(httpObserved,true);assert.equal(httpHadAuthCookie,false);await navigate(origin);assert.equal((await evaluate("probe('auth/get-session')")).userId,data.userId);checks.push('Existing Secure cookie is not sent over HTTP');
  phase='origin';await navigate(`https://other.siteflow.test:${port}`);await evaluate(`fetch(${JSON.stringify(origin+'/api/siteflow/auth/sign-out')},{method:'POST',credentials:'include',headers:{'Content-Type':'text/plain'},body:'{}'}).then(()=>true).catch(()=>false)`);assert.equal(crossOriginStatus,403);assert.equal(crossOriginHadCookie,true);await navigate(origin);assert.equal((await evaluate("probe('auth/get-session')")).userId,data.userId);checks.push('Different Origin rejected despite cookie being sent; existing session remains valid');
  phase='layout';await evaluate('refresh()');for(const width of [1440,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,`https-cookie-${width}.png`),Buffer.from(shot.data,'base64'));}checks.push('Dedicated test page fits 1440/390; screenshots contain no credentials');
  phase='logout';await evaluate("document.getElementById('logout').click()");await wait("document.getElementById('state').textContent.includes('ログアウト済み')",'LOGOUT');assert.equal((await sessionCookies()).length,0);await send('Page.reload',{ignoreCache:true});await wait('!!window.probe','LOGOUT_RELOAD');assert.equal((await evaluate("probe('auth/get-session')")).userId,null);assert.equal((await evaluate("probe('teams')")).status,401);assert.equal(await prisma.session.count({where:{userId:data.userId}}),0);checks.push('Logout removes browser cookie and DB session; reload stays logged out');
  }
  succeeded=true;
}catch(error){
  if(send&&ws?.readyState===WebSocket.OPEN){try{const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'failure.png'),Buffer.from(shot.data,'base64'));}catch{/* 個人用Chromeは操作しない */}}
  const reason=/^(?:TLS_FIXTURE_FAILED_|TIMEOUT_|NEXT_|INVALID_|NONLOCAL_)/.test(error?.message??'')?error.message:error?.name??'FAILED';
  console.error('HTTPS cookie check failed at '+phase+'; '+reason+(nextMode?'; API statuses='+nextStatuses.join(','):''));process.exitCode=1;
}
finally{
  if(send&&ws?.readyState===WebSocket.OPEN){await send('Browser.close').catch(()=>{});ws.close();}child?.kill();
  const cleanup=await Promise.allSettled([close(tlsServer),close(plainServer),api?.close(),stopNext()]);
  cleanup.push(...await Promise.allSettled([(async()=>{try{if(data)await removeLocalWorkspaceData(prisma,data);}finally{await prisma?.$disconnect();}})()]));
  cleanup.push(...await Promise.allSettled([tlsFixture?.close()]));
  if(volumeCreated)cleanup.push(...await Promise.allSettled([Promise.resolve().then(()=>dockerCall(['volume','rm',checkResource]))]));
  if(networkCreated)cleanup.push(...await Promise.allSettled([Promise.resolve().then(()=>dockerCall(['network','rm',checkResource]))]));
  // 自分で作った直下の一時ディレクトリだけを削除し、普段のChrome/証明書ストアは触らない。
  if(path.dirname(path.resolve(temporary))===path.resolve(os.tmpdir())&&path.basename(temporary).startsWith('siteflow-https-cookies-'))cleanup.push(...await Promise.allSettled([fs.promises.rm(temporary,{recursive:true,force:true,maxRetries:8,retryDelay:250})]));
  if(cleanup.some(result=>result.status==='rejected')||fs.existsSync(temporary)){console.error('HTTPS cookie cleanup failed');process.exitCode=1;}
}
if(succeeded&&!process.exitCode){fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,checks,measurements,tlsProtocol,databaseTls:tlsFixture?.tlsVersion,temporaryResourcesRemoved:true,certificate:'temporary self-signed HTTPS certificate with per-key SPKI exception in dedicated Chrome',scope:dockerPublic?'standalone Next.js Docker + TLS MySQL with named-volume recreation; local Node HTTPS proxy, not real Nginx or AWS':integratedPublic?'built Next.js integrated API and TLS MySQL in disposable local container; not AWS deployment':nextMode?'built Next.js workspace and real route over loopback HTTPS; not public DB TLS':'loopback HTTPS test harness; not Next.js production route or public DB TLS'},null,2));console.log(`PASS: ${checks.length} ${dockerPublic?'Docker public':integratedPublic?'integrated public':nextMode?'Next.js preview':'HTTPS browser'} scenarios; ${tlsProtocol}; temporary fixture/profile/certificate removed`);}
