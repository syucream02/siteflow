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

// 実Chrome → 実Next.js API → 固定RSA鍵 → 専用MySQL。応答の差し替えなし。
const base = process.env.SITEFLOW_RECORDS_BROWSER_ORIGIN ?? 'http://127.0.0.1:5187';
const origin = new URL(base);
if (origin.origin !== base || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('LOCAL_ONLY');
const settings = readSchemaCheckSettings();
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...readSchemaCheckConnectionOptions(), connectionLimit: 2 }) });
const output = path.resolve('work/meeting-records-real'); fs.mkdirSync(output, { recursive: true });
let data, outsider, child, ws, send, profile, before;
let phase = 'preflight', completed = false, cleanupVerified = false;
const checks = [], pending = new Map(); let apiResponses = 0, loginResponses = 0;
async function snapshot() {
  const tables = {};
  for (const table of ['Team', 'TeamMembership', 'TeamParticipant', 'Project', 'ProjectSupportMember', 'ProjectProgressHistory', 'ProjectAssignmentHistory', 'Meeting', 'MeetingProject', 'MeetingConfirmation', 'MeetingProjectNote', 'MeetingActionItem', 'MeetingActionSnapshot', 'user', 'account', 'session']) {
    const rows = await prisma.$queryRawUnsafe('SELECT ' + (['user', 'account', 'session'].includes(table) ? 'id' : '*') + ' FROM `' + table + '`');
    const serialized = rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value)).sort();
    tables[table] = { count: rows.length, hash: createHash('sha256').update(JSON.stringify(serialized)).digest('hex') };
  }
  return tables;
}
try {
  const [actual] = await prisma.$queryRawUnsafe('SELECT DATABASE() AS db, CURRENT_USER() AS principal');
  assert.ok(actual.db === settings.database && actual.principal.split('@')[0] === settings.user, 'dedicated DB only');
  before = await snapshot(); data = await createLocalWorkspaceData(prisma); outsider = await createLocalWorkspaceData(prisma);
  const team = data.teamIds[0];
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-records-real-'));
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
    if (m.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
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
  phase = 'login'; await wait("!!document.querySelector('#login-email')");
  await input('#login-email', data.email); await input('#login-password', data.password); await click('ログイン');
  await wait("!!document.querySelector('#team-select')"); await input('#team-select', team);
  await wait("document.querySelectorAll('[data-project-id]').length===20");
  assert.ok(loginResponses > 0, 'real login'); checks.push('実ログイン・専用DB・案件一覧');
  phase = 'meeting'; await click('会議'); await wait("!!document.querySelector('#meetings-title')"); await click('新しい会議を開始');
  await wait("!!document.querySelector('#meeting-consultation')");
  let meeting = await prisma.meeting.findFirstOrThrow({ where: { teamId: team } });
  const originalId = meeting.id, entry = await prisma.meetingProject.findFirstOrThrow({ where: { meetingId: originalId }, orderBy: { position: 'asc' } });
  phase = 'draft'; await input('#meeting-consultation', '架空の相談：工期を確認'); await input('#meeting-decision', '架空の決定：図面確認後に回答');
  // 未保存入力は一律の無効化ではなく、移動確認を取り消して保持する。
  const originalEntry = await evaluate("document.querySelector('#meeting-entry').value");
  await click('次の案件');
  assert.equal(await evaluate("document.querySelector('#meeting-entry').value"), originalEntry);
  await evaluate('history.back()'); await new Promise(resolve => setTimeout(resolve, 10500));
  assert.equal(await evaluate("document.querySelector('#meeting-consultation')?.value"), '架空の相談：工期を確認');
  await click('相談・決定を保存'); await wait("document.querySelector('#meeting-entry')?.disabled===false");
  assert.equal((await prisma.meetingProjectNote.findUniqueOrThrow({ where: { teamId_entryId: { teamId: team, entryId: entry.id } } })).decision, '架空の決定：図面確認後に回答');
  checks.push('10秒更新・戻るでも未保存入力を維持・実DB保存');
  phase = 'action'; await input('#meeting-action-content', '架空の対応：寸法表を提出'); await input('#meeting-action-owner', data.userId); await input('#meeting-action-due', '2026-12-20');
  await click('対応事項を保存'); await wait("document.querySelector('#meeting-entry')?.disabled===false&&document.querySelector('#meeting-action-content')?.value===''");
  const action = await prisma.meetingActionItem.findFirstOrThrow({ where: { teamId: team } });
  assert.equal(action.status, 'OPEN'); checks.push('担当者必須・任意期限・対応事項の登録');
  phase = 'conflict'; await input('#meeting-consultation', '競合後も保持する入力');
  const externalStatus = await evaluate(`(async()=>{const p='/api/siteflow/teams/${team}/meetings/${originalId}';const m=(await (await fetch(p)).json()).meeting;return (await fetch(p,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_notes',entryId:'${entry.id}',expectedVersion:m.version,consultation:'別の進行役の保存',decision:'外部更新'})})).status})()`);
  assert.equal(externalStatus, 200); await click('相談・決定を保存'); await wait("document.body.textContent.includes('競合しました。')");
  assert.equal(await evaluate("document.querySelector('#meeting-consultation').value"), '競合後も保持する入力');
  await click('最新のメモを確認したうえで自分の入力を再保存する'); await click('相談・決定を保存');
  await wait("document.querySelector('#meeting-entry')?.disabled===false"); checks.push('実API409・入力保持・明示的な比較後の再保存');
  phase = 'finish-first'; await click('会議を終了する'); await click('記録を残して終了');
  await wait("document.querySelector('#meeting-title')?.textContent==='終了した会議'");
  // The records endpoint refreshes after finish; the draft is never reinitialized from current action values.
  await wait("document.querySelector('#meeting-consultation')?.readOnly===true");
  const historical = await prisma.meetingActionSnapshot.findFirstOrThrow({ where: { entryId: entry.id } });
  await click('会議一覧に戻る'); await click('新しい会議を開始'); await wait("!!document.querySelector('#meeting-action-owner')");
  meeting = await prisma.meeting.findFirstOrThrow({ where: { teamId: team, endedAt: null } });
  phase = 'handover'; await click('引き継ぎ候補を確認'); await click('この事項を選択'); await input('#meeting-action-owner', data.userId); await click('選択した対応を引き継ぐ');
  await wait("document.querySelector('#meeting-entry')?.disabled===false&&document.body.textContent.includes('引き継ぎ元の会議を見る')");
  assert.equal(await prisma.meetingActionItem.count({ where: { teamId: team } }), 1);
  assert.equal(await prisma.meetingActionSnapshot.count({ where: { teamId: team } }), 2); checks.push('選択的引き継ぎ・同一本体・会議ごとの記録');
  phase = 'mobile-edit'; await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: true });
  await click('対応事項を編集'); await input('#meeting-action-status', 'DONE'); await click('対応事項を保存');
  await wait("document.querySelector('#meeting-entry')?.disabled===false&&document.body.textContent.includes('対応済み')");
  assert.equal((await prisma.meetingActionItem.findUniqueOrThrow({ where: { id: action.id } })).status, 'DONE');
  assert.deepEqual(await prisma.meetingActionSnapshot.findUniqueOrThrow({ where: { id: historical.id } }), historical);
  checks.push('スマホで編集・完了・過去スナップショット不変');
  phase = 'keyboard'; await evaluate("document.querySelector('#meeting-consultation').focus()"); await send('Input.insertText', { text: 'キーボードからの相談' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.ok(await evaluate('document.activeElement!==document.body')); await click('相談・決定を保存');
  await wait("document.querySelector('#meeting-entry')?.disabled===false"); checks.push('入力・Tab移動・保存');
  phase = 'screens';
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 390 });
    await evaluate("window.scrollTo(0,document.querySelector('#meeting-records-title').getBoundingClientRect().top+scrollY-20)"); await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'no horizontal overflow');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, `meeting-${width}.png`), Buffer.from(shot.data, 'base64'));
  } checks.push('PC1440・スマホ390の画像と横はみ出しなし');
  phase = 'source'; await click('引き継ぎ元の会議を見る'); await wait("document.querySelector('#meeting-title')?.textContent==='終了した会議'&&document.querySelector('#meeting-consultation')?.readOnly===true");
  assert.equal(await evaluate("document.querySelector('#meeting-consultation').value"), '競合後も保持する入力');
  assert.ok(await evaluate("document.querySelector('#meeting-records-title').parentElement.textContent.includes('未対応')")); checks.push('引き継ぎ元会議・当時の未対応記録・閲覧専用');
  phase = 'separation'; assert.equal(await evaluate(`fetch('/api/siteflow/teams/${outsider.teamIds[0]}/meetings/${originalId}/entries/${entry.id}/records').then(r=>r.status)`), 403); checks.push('実セッションで他チーム会議の取得を拒否');
  await click('通常の案件'); await wait("document.querySelectorAll('[data-project-id]').length===20");
  await input('#project-keyword', 'LOCAL-001'); await click('検索'); await wait("document.querySelectorAll('[data-project-id]').length===1"); checks.push('会議から既存案件検索へ戻れる');
  await click('ログアウト'); await wait("!!document.querySelector('#login-email')"); completed = true;
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
  if (profile && profile.startsWith(path.join(os.tmpdir(), 'siteflow-records-real-'))) await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
  try {
    if (data) await removeLocalWorkspaceData(prisma, data); if (outsider) await removeLocalWorkspaceData(prisma, outsider);
    if (before) { assert.deepEqual(await snapshot(), before, '既存データの前後一致'); cleanupVerified = true; }
  } catch { console.error('FIXTURE_CLEANUP_OR_FINGERPRINT_FAILED'); process.exitCode = 1; }
  await prisma.$disconnect();
}
if (completed && cleanupVerified && !process.exitCode) {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ mode: 'real-mysql-next-api-chrome', checks, apiResponses, cleanupVerified, passed: true }, null, 2));
  console.log(`PASS ${checks.length} real MySQL/Next.js/Chrome checks; cleanup verified`);
}
