import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { readSchemaCheckSettings, readSchemaCheckConnectionOptions } from './schema-check-settings.mjs';
import { createLocalWorkspaceData, removeLocalWorkspaceData } from './local-workspace-data.ts';

// 実Chrome → 実Next.js API → 固定RSA鍵 → 専用MySQL。
// 通常は応答の差替えなし。creation-failure-onlyは保存後の応答だけを遮断する通信障害試験。
const base = process.env.SITEFLOW_TEAMS_BROWSER_ORIGIN ?? 'http://127.0.0.1:5187';
const origin = new URL(base);
if (origin.origin !== base || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('LOCAL_ONLY');
const settings = readSchemaCheckSettings();
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...readSchemaCheckConnectionOptions(), connectionLimit: 2 }) });
const faultOnly = process.argv.includes('--creation-failure-only');
const output = path.resolve(faultOnly ? 'work/team-management-fault' : 'work/team-management-real'); fs.mkdirSync(output, { recursive: true });
let data, outsider, child, ws, send, profile, before;
let phase = 'preflight', completed = false, cleanupVerified = false;
const extraUsers = [], checks = [], pending = new Map(); let apiResponses = 0, loginResponses = 0;
async function snapshot() {
  const tables = {};
  for (const table of ['Team', 'TeamMembership', 'TeamParticipant', 'Project', 'ProjectSupportMember', 'ProjectProgressHistory', 'ProjectAssignmentHistory', 'Meeting', 'MeetingProject', 'MeetingConfirmation', 'MeetingProjectNote', 'MeetingActionItem', 'MeetingActionSnapshot', 'invitation', 'user', 'account', 'session']) {
    const rows = await prisma.$queryRawUnsafe('SELECT ' + (['user', 'account', 'session'].includes(table) ? 'id' : '*') + ' FROM `' + table + '`');
    const serialized = rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value)).sort();
    tables[table] = { count: rows.length, hash: createHash('sha256').update(JSON.stringify(serialized)).digest('hex') };
  }
  return tables;
}
try {
const [actual]=await prisma.$queryRawUnsafe('SELECT DATABASE() db,CURRENT_USER() principal');
assert.ok(actual.db===settings.database&&actual.principal.split('@')[0]===settings.user,'dedicated DB only');
before=await snapshot();data=await createLocalWorkspaceData(prisma);outsider=await createLocalWorkspaceData(prisma);
await prisma.teamMembership.deleteMany({where:{userId:data.userId,teamId:{in:data.teamIds}}});
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-teams-real-'));
  child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert.ok(port, '専用Chrome');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP_TIMEOUT')); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: () => { clearTimeout(timeout); reject(new Error('CDP_FAILED')); } }); ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: faultOnly }).catch(() => {});
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(); else p.resolve(m.result); }
    if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(base + '/api/siteflow/')) { apiResponses++; if (m.params.response.url.endsWith('/auth/sign-in/email') && m.params.response.status === 200) loginResponses++; }
  };
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('BROWSER_EXPRESSION'); return r.result.value; };
  const wait = async expression => { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('UI_TIMEOUT'); };
  const input = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  const click = async text => { const selector = `[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}&&e.offsetParent!==null&&!e.disabled)`; await wait(`!!(${selector})`); await evaluate(`(${selector}).click()`); };


  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/workspace' });
  phase='login-zero';await wait("!!document.querySelector('#login-email')");await input('#login-email',data.email);await input('#login-password',data.password);await click('ログイン');
  if (faultOnly) {
    await wait("document.body.textContent.includes('所属チームはまだありません')");
    const originalMessage = ws.onmessage; let posts = 0;
    ws.onmessage = event => { const m = JSON.parse(event.data); if (m.method === 'Fetch.requestPaused') {
      if (m.params.request.method === 'POST') { posts++; void send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionReset' }).catch(() => {}); }
      else void send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    } originalMessage(event); };
    await send('Fetch.enable', { patterns: [{ urlPattern: base + '/api/siteflow/teams', requestStage: 'Response' }] });
    await click('チームを作成');await wait("!!document.querySelector('#new-team-name')");
    const name='応答喪失の架空チーム '+randomUUID();await input('#new-team-name',name);await click('チームを作成する');
    await wait("document.body.textContent.includes('作成結果を確認できません')");
    const saved=await prisma.team.findFirstOrThrow({where:{name}});data.teamIds.push(saved.id);
    assert.equal(posts,1);assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='チームを作成する').disabled"),true);
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='チームを作成する').click()");
    await new Promise(r=>setTimeout(r,200));assert.equal(posts,1);assert.equal(await prisma.team.count({where:{name}}),1);
    await send('Fetch.disable');await click('入力を破棄して所属一覧を確認');await wait(`document.querySelector('#team-select')?.value===${JSON.stringify(saved.id)}`);
    checks.push('DB確定後の応答喪失でも自動再送せず、所属一覧で作成済み1件を確認');completed=true;
  } else {
  await wait("document.body.textContent.includes('所属チームはまだありません')");assert.ok(loginResponses>0);await click('自分宛ての招待');await wait("document.body.textContent.includes('自分宛ての招待はありません')");checks.push('実ログイン・所属0件でも作成/招待への導線');
  phase='create';await click('チームを作成');await wait("!!document.querySelector('#new-team-name')");const teamName='通し確認チーム '+randomUUID();await input('#new-team-name',teamName);
  await evaluate("document.querySelector('#new-team-name').focus()");await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  let team;for(let n=0;n<100;n++){team=await prisma.team.findFirst({where:{name:teamName}});if(team)break;await new Promise(r=>setTimeout(r,100));}assert.ok(team,'team created');data.teamIds.push(team.id);
  await wait(`document.querySelector('#team-select')?.value===${JSON.stringify(team.id)}`);checks.push('Enterでチーム作成・作成チームへ移動・本人admin');
  const members=Array.from({length:24},(_,i)=>({id:randomUUID(),name:'架空の所属者 '+(i+1),emailVerified:true}));extraUsers.push(...members.map(m=>m.id));
  await prisma.user.createMany({data:members.map(m=>({...m,email:m.id+'@example.invalid'}))});await prisma.teamMembership.createMany({data:members.map(m=>({id:randomUUID(),teamId:team.id,userId:m.id,role:'member',createdAt:new Date()}))});
  const invitations=Array.from({length:21},()=>({id:randomUUID(),teamId:team.id,inviterId:data.userId,email:randomUUID()+'@example.invalid',role:'member',status:'pending',expiresAt:new Date(Date.now()+86400000)}));await prisma.invitation.createMany({data:invitations});
  phase='settings';await click('チーム設定');await wait("!!document.querySelector('#settings-team-name')");await wait("document.querySelectorAll('[data-member-id]').length===20");await click('メンバーをさらに表示');await wait("document.querySelectorAll('[data-member-id]').length===25");
  await click('チームの招待をさらに表示');await wait("document.querySelectorAll('[data-team-invite-id]').length===21");checks.push('25メンバー・21招待のページ分割');
  phase='draft-conflict';await input('#settings-team-name','入力を保持したチーム名');await evaluate('history.back()');await wait("document.querySelector('#settings-team-name')?.value==='入力を保持したチーム名'");
  const externalStatus=await evaluate(`(async()=>{const p='/api/siteflow/teams/${team.id}/settings',s=await(await fetch(p)).json();return(await fetch(p,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'別操作の変更',expectedVersion:s.team.version})})).status})()`);assert.equal(externalStatus,200);
  await click('チーム名を保存');await wait("document.body.textContent.includes('最新のチーム名：別操作の変更')");assert.equal(await evaluate("document.querySelector('#settings-team-name').value"),'入力を保持したチーム名');await click('最新情報を確認して再試行する');await click('チーム名を保存');
  await wait("document.querySelector('#team-select')?.disabled===false");assert.equal((await prisma.team.findUniqueOrThrow({where:{id:team.id}})).name,'入力を保持したチーム名');checks.push('戻ると409で入力保持・比較して改名・slug維持');
  phase='roles';await click('メンバーをさらに表示');await wait("document.querySelectorAll('[data-member-id]').length===25");
  await evaluate(`document.querySelector('[data-member-id="${members[0].id}"] button').click()`);await click('役割変更を確定');await wait("document.querySelector('#team-select')?.disabled===false");
  assert.equal((await prisma.teamMembership.findUniqueOrThrow({where:{teamId_userId:{teamId:team.id,userId:members[0].id}}})).role,'admin');checks.push('確認画面を経た役割変更・実DB保存');
  phase='remove';await click('メンバーをさらに表示');await wait("document.querySelectorAll('[data-member-id]').length===25");await evaluate(`([...document.querySelector('[data-member-id="${members[1].id}"]').querySelectorAll('button')].find(b=>b.textContent==='所属解除を確認')).click()`);
  await click('所属解除・退出を確定');await wait("document.querySelector('#team-select')?.disabled===false");assert.equal(await prisma.teamMembership.count({where:{teamId:team.id,userId:members[1].id}}),0);checks.push('解除前チェックと明示確認・所属だけを解除');
  phase='invite';await input('#team-invite-email',outsider.email);await click('招待を作成');await wait("document.querySelector('#team-invite-email')?.value===''&&document.querySelector('#team-select')?.disabled===false");
  const actualInvite=await prisma.invitation.findFirstOrThrow({where:{teamId:team.id,email:outsider.email,status:'pending'}});
  const toCancel=await prisma.invitation.findFirstOrThrow({where:{teamId:team.id,status:'pending',email:{not:outsider.email}},orderBy:{id:'asc'}});
  await evaluate(`([...document.querySelector('[data-team-invite-id="${toCancel.id}"]').querySelectorAll('button')].find(b=>b.textContent==='招待を取消')).click()`);await wait("document.querySelector('#team-select')?.disabled===false");assert.equal((await prisma.invitation.findUniqueOrThrow({where:{id:toCancel.id}})).status,'canceled');checks.push('既存アカウントへの招待・取消・メール送信なし');
  phase='screens';for(const width of [1440,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width===390});await evaluate("window.scrollTo(0,document.querySelector('#team-settings-title').getBoundingClientRect().top+scrollY-20)");await new Promise(r=>setTimeout(r,150));assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,`team-${width}.png`),Buffer.from(shot.data,'base64'));}checks.push('PC1440・スマホ390画像・横はみ出しなし');
  const otherTeam=await prisma.team.create({data:{id:randomUUID(),name:'辞退する架空のチーム',slug:'browser-'+randomUUID(),createdAt:new Date()}});data.teamIds.push(otherTeam.id);await prisma.teamMembership.create({data:{id:randomUUID(),teamId:otherTeam.id,userId:data.userId,role:'admin',createdAt:new Date()}});
  const {createTeamInvitation}=await import('./team-invitation-service.ts');const toDecline=await createTeamInvitation(prisma,data.userId,otherTeam.id,outsider.email,1);assert.ok(toDecline.ok);
  await prisma.invitation.createMany({data:[{id:randomUUID(),teamId:team.id,email:outsider.email,inviterId:data.userId,role:'member',status:'pending',expiresAt:new Date(Date.now()-1000)},{id:randomUUID(),teamId:team.id,email:outsider.email,inviterId:data.userId,role:'member',status:'canceled',expiresAt:new Date(Date.now()+86400000)}]});
  phase='recipient';await click('ログアウト');await wait("!!document.querySelector('#login-email')");await input('#login-email',outsider.email);await input('#login-password',outsider.password);await click('ログイン');await wait("!!document.querySelector('#team-select')");await click('自分宛ての招待');
  await wait(`!!document.querySelector('[data-invitation-id="${actualInvite.id}"]')`);assert.ok(await evaluate("document.body.textContent.includes('期限切れ')&&document.body.textContent.includes('取消済み')"));
  phase='decline';await evaluate(`([...document.querySelector('[data-invitation-id="${toDecline.invitation.id}"]').querySelectorAll('button')].find(b=>b.textContent==='辞退する')).click()`);await wait(`!document.querySelector('[data-invitation-id="${toDecline.invitation.id}"] button')&&document.querySelector('[data-invitation-id="${actualInvite.id}"] button')?.disabled===false`);
  phase='accept';
  await evaluate(`([...document.querySelector('[data-invitation-id="${actualInvite.id}"]').querySelectorAll('button')].find(b=>b.textContent==='参加する')).click()`);await wait(`document.querySelector('#team-select')?.value===${JSON.stringify(team.id)}`);checks.push('本人一覧だけの招待・期限/取消表示・辞退と参加');
  phase='member';await click('チーム設定');await wait("document.querySelector('#settings-team-name')?.readOnly===true");assert.equal(await evaluate("!!document.querySelector('#team-invite-email')"),false);assert.equal((await prisma.teamMembership.findUniqueOrThrow({where:{teamId_userId:{teamId:team.id,userId:outsider.userId}}})).role,'member');
  await click('このチームから退出');await click('所属解除・退出を確定');await wait(`document.querySelector('#team-select')?.value!==${JSON.stringify(team.id)}&&!!document.querySelector('#team-select')`);assert.equal(await evaluate(`fetch('/api/siteflow/teams/${team.id}/settings').then(r=>r.status)`),403);assert.equal(await evaluate("fetch('/api/siteflow/auth/get-session').then(r=>r.status)"),200);checks.push('一般メンバー表示・退出後403・他チームとセッション維持');
  phase='revocation';
  const auth=await fetch(base+'/api/siteflow/auth/sign-in/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:data.email,password:data.password})});assert.equal(auth.status,200);const ownerCookie=auth.headers.getSetCookie().find(v=>v.includes('session_token=')).split(';')[0];
  const renewed=await createTeamInvitation(prisma,data.userId,team.id,outsider.email,(await prisma.team.findUniqueOrThrow({where:{id:team.id}})).version);assert.ok(renewed.ok);await click('自分宛ての招待');await wait(`!!document.querySelector('[data-invitation-id="${renewed.invitation.id}"]')`);await evaluate(`([...document.querySelector('[data-invitation-id="${renewed.invitation.id}"]').querySelectorAll('button')].find(b=>b.textContent==='参加する')).click()`);await wait(`document.querySelector('#team-select')?.value===${JSON.stringify(team.id)}`);await click('チーム設定');await wait("!!document.querySelector('#settings-team-name')");
  const removed=await fetch(base+`/api/siteflow/teams/${team.id}/members/${outsider.userId}`,{method:'DELETE',headers:{Cookie:ownerCookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:(await prisma.team.findUniqueOrThrow({where:{id:team.id}})).version})});assert.equal(removed.status,200);
  await click('チーム設定を再取得');await wait(`document.querySelector('#team-select')?.value!==${JSON.stringify(team.id)}&&!!document.querySelector('#team-select')`);assert.equal(await evaluate("!!document.querySelector('#settings-team-name')"),false);checks.push('外部からの所属解除後に画面と保持データをクリア');
  await click('ログアウト');await wait("!!document.querySelector('#login-email')");completed=true;
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase, code: error?.name ?? 'ERROR' })); process.exitCode = 1;
  if (send && ws?.readyState === WebSocket.OPEN) {
    const safe = await send('Runtime.evaluate', { expression: "!document.querySelector('input[type=password]')", returnByValue: true }).catch(() => null);
    if (safe?.result?.value) { const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).catch(() => null); if (shot) fs.writeFileSync(path.join(output, 'failure.png'), Buffer.from(shot.data, 'base64')); }
  }
} finally {
  if (send && ws?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); ws.close(); }
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  for (const p of pending.values()) p.reject(); pending.clear();
  if (profile && profile.startsWith(path.join(os.tmpdir(), 'siteflow-teams-real-'))) await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
  try {
    if (data) await removeLocalWorkspaceData(prisma, data); if (outsider) await removeLocalWorkspaceData(prisma, outsider);
    if (extraUsers.length) await prisma.user.deleteMany({where:{id:{in:extraUsers}}});
    if (before) { assert.deepEqual(await snapshot(), before, '既存データの前後一致'); cleanupVerified = true; }
  } catch { console.error('FIXTURE_CLEANUP_OR_FINGERPRINT_FAILED'); process.exitCode = 1; }
  await prisma.$disconnect();
}
if (completed && cleanupVerified && !process.exitCode) {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ mode: 'real-mysql-next-api-chrome', checks, apiResponses, cleanupVerified, passed: true }, null, 2));
  console.log(`PASS ${checks.length} real MySQL/Next.js/Chrome checks; cleanup verified`);
}
