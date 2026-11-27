import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { readSchemaCheckSettings, readSchemaCheckConnectionOptions } from './schema-check-settings.mjs';
import { createLocalWorkspaceData, removeLocalWorkspaceData } from './local-workspace-data.ts';

// 実Chrome → 実Next.js API → 固定RSA鍵 → 専用MySQL。
// 保存後の応答遮断・再取得失敗をブラウザー側で再現する。API・DBの保存処理は実物。
const base = process.env.SITEFLOW_RELIABILITY_ORIGIN ?? 'http://127.0.0.1:5193';
const origin = new URL(base);
if (origin.origin !== base || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('LOCAL_ONLY');
const settings = readSchemaCheckSettings();
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...readSchemaCheckConnectionOptions(), connectionLimit: 2 }) });
const output = path.resolve('work/reliability-browser'); fs.mkdirSync(output, { recursive: true });
let data, outsider, child, ws, send, profile, before;
let phase = 'preflight', completed = false, cleanupVerified = false;
const extraUsers = [], checks = [], pending = new Map(); let apiResponses = 0;
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
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(); else p.resolve(m.result); }
    if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(base + '/api/siteflow/')) apiResponses++;
  };
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('BROWSER_EXPRESSION'); return r.result.value; };
  const wait = async expression => { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('UI_TIMEOUT'); };
  const input = async (selector, value) => { await wait(`!!document.querySelector(${JSON.stringify(selector)}) && (document.querySelector(${JSON.stringify(selector)}).tagName!=='SELECT' || [...document.querySelector(${JSON.stringify(selector)}).options].some(o=>o.value===${JSON.stringify(value)}))`); return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`); };
  const click = async text => { const selector = `[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}&&e.offsetParent!==null&&!e.disabled)`; await wait(`!!(${selector})`); const pos=await evaluate(`(()=>{const e=(${selector});e.scrollIntoView({block:'center'});e.focus();const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pos});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pos}); };



  let acceptDialog = false, dialogs = 0, fault = null, held = null;
  const originalMessage = ws.onmessage;
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Page.javascriptDialogOpening') { dialogs++; void send('Page.handleJavaScriptDialog', { accept: acceptDialog }).catch(() => {}); }
    if (m.method === 'Fetch.requestPaused') {
      const p = m.params;
      if (fault && !fault.used && p.request.url.includes(fault.path) && p.request.method === fault.method) {
        fault.used = true;
        if (fault.mode === 'hold') held = p.requestId;
        else if (fault.mode === 'drop') void send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' }).catch(() => {});
        else void send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"message":"INTERNAL_SQL_MUST_NOT_APPEAR"}').toString('base64') }).catch(() => {});
      } else void send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
    originalMessage(event);
  };
  const intercept = async (method, path, mode, stage = 'Response') => {
    fault = { method, path, mode, used: false }; held = null;
    await send('Fetch.enable', { patterns: [{ urlPattern: base + '/api/siteflow/*', requestStage: stage }] });
  };
  const disable = async () => { await send('Fetch.disable'); fault = null; };
  const login = async user => { await wait("!!document.querySelector('#login-email')"); await input('#login-email', user.email); await input('#login-password', user.password); await click('ログイン'); await wait("!!document.querySelector('#team-select')"); };
  const team = data.teamIds[0];
  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/workspace?team=' + team + '&view=projects' });
  phase = 'login'; await login(data); await wait("document.querySelectorAll('[data-project-id]').length===20");
  checks.push('実ログイン・専用MySQL21件の検索一覧');

  phase = 'create-dirty'; await click('新しい案件を登録'); await wait("!!document.querySelector('#project-name')");
  const beforeDialogs = dialogs;
  await input('#project-name', '保持する下書き'); await click('入力を破棄して一覧へ戻る');
  assert.equal(dialogs, beforeDialogs + 1); assert.equal(await evaluate("document.querySelector('#project-name').value"), '保持する下書き');
  assert.equal(await evaluate("document.activeElement?.textContent"), '入力を破棄して一覧へ戻る');
  await input('#project-name', ''); await click('入力を破棄して一覧へ戻る'); assert.equal(dialogs, beforeDialogs + 1);
  checks.push('未保存の取消とフォーカス復帰・元の値に戻すと警告解除');

  phase = 'history'; await click('保管一覧'); await click('通常の案件'); await click('新しい案件を登録'); await input('#project-name', '履歴で保持する下書き');
  await evaluate('history.back()'); await wait("document.querySelector('#project-name')?.value==='履歴で保持する下書き'");
  const marker = dialogs; await click('チーム設定'); assert.equal(dialogs, marker + 1); assert.ok(await evaluate("!!document.querySelector('#project-name')"));
  const reloadDialog = dialogs; await send('Page.reload'); await wait(`document.querySelector('#project-name')?.value==='履歴で保持する下書き'`); assert.ok(dialogs > reloadDialog);
  acceptDialog = true; await click('チーム設定'); await wait("!!document.querySelector('#settings-team-name')"); acceptDialog = false;
  checks.push('戻るの取消・画面切替の取消と破棄して移動');

  phase = 'team-revert'; const teamName = await evaluate("document.querySelector('#settings-team-name').value");
  await input('#settings-team-name', teamName + '変更'); await input('#settings-team-name', teamName);
  const cleanDialogs = dialogs; await click('通常の案件'); assert.equal(dialogs, cleanDialogs);
  checks.push('チーム名を元へ戻すと移動警告なし');

  phase = 'create-response-loss'; await click('新しい案件を登録');
  const createdName = '応答喪失の架空案件'; await input('#project-name', createdName); await input('#project-due', '2026-12-30'); await input('#project-primary', data.userId);
  await intercept('POST', '/projects', 'drop'); await click('案件を登録する');
  await wait("document.body.textContent.includes('登録結果を確認できません')"); assert.equal(await prisma.project.count({ where: { teamId: team, name: createdName } }), 1);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='案件を登録する').disabled"), true);
  await disable(); acceptDialog = true; await click('入力を破棄して一覧へ戻る'); acceptDialog = false;
  checks.push('実DB保存後のPOST応答喪失・入力保持・無条件の再送禁止');

  phase = 'edit-dirty'; await wait("document.querySelectorAll('[data-project-id]').length===20");
  const projectId = await evaluate("document.querySelector('[data-project-id]').dataset.projectId");
  await evaluate("document.querySelector('[data-project-id] button').click()"); await wait("document.body.textContent.includes('基本情報を編集')"); await click('基本情報を編集'); await wait("!!document.querySelector('#edit-name')");
  const originalName = await evaluate("document.querySelector('#edit-name').value");
  await input('#edit-name', originalName + '入力'); await click('入力を破棄して戻る'); assert.equal(await evaluate("document.querySelector('#edit-name').value"), originalName + '入力');
  await prisma.project.update({ where: { id: projectId }, data: { name: '別操作による案件名', version: { increment: 1 } } });
  await click('変更を保存する'); await wait("document.body.textContent.includes('保存前と最新の内容を比較')"); assert.equal(await evaluate("document.querySelector('#edit-name').value"), originalName + '入力');
  await click('最新の内容を確認する'); await wait("document.body.textContent.includes('別操作による案件名')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='変更を保存する').disabled"), true);
  await click('比較しました。入力を保持して保存可能にする');
  await intercept('PATCH', '/projects/' + projectId, 'hold');
  await evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='変更を保存する');b.click();b.click();})()");
  for (let i=0;i<100&&!held;i++) await new Promise(r=>setTimeout(r,50)); assert.ok(held); assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).version, 3);
  await send('Fetch.continueRequest', { requestId: held }); await disable(); await wait("document.body.textContent.includes('保存を確認しました')");
  checks.push('実409で入力保持・明示比較後のみ保存・連打でも版加算1回');

  phase = 'saved-refresh-failure'; await click('基本情報を編集'); await input('#edit-name', '保存済み再取得失敗');
  await intercept('GET', '/projects/' + projectId, '503'); await click('変更を保存する'); await wait("document.body.textContent.includes('保存を確認しました')&&document.body.textContent.includes('再取得')");
  assert.equal((await prisma.project.findUniqueOrThrow({where:{id:projectId}})).name, '保存済み再取得失敗'); assert.equal(await evaluate("!!document.querySelector('#edit-name')"), false);
  await disable(); checks.push('保存成功後のGET失敗でも保存失敗と扱わず再送フォームを出さない');

  phase = 'meeting'; await click('会議'); await click('新しい会議を開始'); await wait("!!document.querySelector('#meeting-consultation')");
  await input('#meeting-consultation', '自動更新中も保持する相談'); await new Promise(r=>setTimeout(r,10500)); assert.equal(await evaluate("document.querySelector('#meeting-consultation').value"), '自動更新中も保持する相談');
  await input('#meeting-consultation', ''); const noDirty = dialogs; await click('会議一覧に戻る'); assert.equal(dialogs,noDirty);
  phase = 'meeting-resume'; await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('会議を再開'))");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('会議を再開')).click()"); await wait("!!document.querySelector('#meeting-consultation')");
  await input('#meeting-consultation', '終了時に保護する相談'); await click('会議を終了する'); assert.ok(await evaluate("!document.querySelector('#finish-meeting-title')"));
  phase = 'meeting-response-loss'; await intercept('PATCH','/meetings/','drop'); await click('相談・決定を保存'); await wait("document.body.textContent.includes('保存結果は不明')");
  assert.equal(await prisma.meetingProjectNote.count({where:{teamId:team,consultation:'終了時に保護する相談'}}),1);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='相談・決定を保存').disabled"),true);
  await disable(); checks.push('10秒更新の入力保持・元に戻すと警告解除・終了取消・会議メモの保存後応答喪失');

  phase='screens'; for(const width of [1440,390]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width===390});
    await evaluate("window.scrollTo(0,document.querySelector('#meeting-records-title').getBoundingClientRect().top+scrollY-30)");
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,`reliability-${width}.png`),Buffer.from(shot.data,'base64'));
  } checks.push('PC1440・スマホ390で保存結果不明と確認操作を表示');

  phase='logout-response-loss'; acceptDialog=true; await intercept('POST','auth/sign-out','drop'); await click('ログアウト'); await wait("!!document.querySelector('#login-email')"); acceptDialog=false; await disable();
  checks.push('ログアウトDB確定後の応答喪失・セッション再確認で業務画面を破棄');
  phase='other-account'; await login(outsider); assert.equal(await evaluate("!!document.querySelector('#meeting-consultation')"),false); assert.equal(await evaluate("document.body.textContent.includes('終了時に保護する相談')"),false);
  checks.push('別アカウントへ下書き・会議データを引き継がない');
  phase='expired'; await prisma.session.deleteMany({where:{userId:outsider.userId}});
  await click('チーム設定'); await wait("!!document.querySelector('#login-email')");
  checks.push('実セッション失効後の401で業務画面を破棄'); completed=true;
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
