import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { readSchemaCheckSettings } from './schema-check-settings.mjs';
import { createLocalWorkspaceData, removeLocalWorkspaceData } from './local-workspace-data.ts';

const settings = readSchemaCheckSettings();
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: '127.0.0.1', port: settings.port, user: settings.user, password: settings.password, database: settings.database, connectionLimit: 2 }) });
const base = process.env.SITEFLOW_BROWSER_ORIGIN;
const url = new URL(base);
if (url.origin !== base || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !url.port) throw Error('LOCAL_ORIGIN_REQUIRED');
const output = path.resolve('../../work/meeting-browser'); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-meeting-chrome-'));
let data, child, ws, send, failSave = false, failRead = false, phase = 'setup';
const checks = [];
try {
  data = await createLocalWorkspaceData(prisma);
  fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ userId: data.userId, teamIds: data.teamIds }));
  child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert.ok(port);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params })); });
  ws.onmessage = event => {
    const item = JSON.parse(event.data);
    if (pending.has(item.id)) { const task = pending.get(item.id); pending.delete(item.id); if (item.error) task.reject(Error('CDP_COMMAND_FAILED')); else task.resolve(item.result); }
    if (item.method === 'Fetch.requestPaused') {
      const { requestId, request } = item.params;
      if ((failSave && request.method === 'PATCH' || failRead && request.method === 'GET') && /\/meetings\/[a-f0-9-]+$/.test(request.url)) {
        void send('Fetch.fulfillRequest', { requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ message: '検証用の通信失敗。再試行できます。' })).toString('base64') }).catch(() => {});
      } else void send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  };
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error('BROWSER_EVALUATION_FAILED'); return result.result.value; };
  const waitFor = async (expression, label) => { for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('TIMEOUT_' + label); };
  const click = async label => { await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent===${JSON.stringify(label)}&&!b.disabled)`, 'button'); await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`); };
  const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const select = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const bodyHas = value => `document.body.textContent.includes(${JSON.stringify(value)})`;
  const width = value => send('Emulation.setDeviceMetricsOverride', { width: value, height: 1000, deviceScaleFactor: 1, mobile: value === 390 });
  const fit = async () => assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  const screenshot = async name => { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64')); };
  const key = async (key, code, number) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: number, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: number }); };
  await send('Page.enable'); await send('Network.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*api/siteflow/*', requestStage: 'Request' }] });
  await width(1440); await send('Page.navigate', { url: base + '/workspace' });
  await waitFor("!!document.getElementById('login-email')", 'login');
  await fill('#login-email', data.email); await fill('#login-password', data.password); await click('ログイン');
  await waitFor("!!document.getElementById('team-select')", 'teams');
  await select('#team-select', data.teamIds[0]); await click('会議');
  await waitFor(bodyHas('会議はまだありません。'), 'empty');
  // ローカル専用fixture。比較元を明示し、進行中/終了後の表示を実DBで確かめる。
  const person = await prisma.teamParticipant.findUniqueOrThrow({ where: { teamId_userId: { teamId: data.teamIds[0], userId: data.userId } } });
  const pastStart = new Date(Date.now() - 172800000), pastEnd = new Date(Date.now() - 86400000);
  const previous = await prisma.meeting.create({ data: { teamId: data.teamIds[0], createdByParticipantId: person.id, startedAt: pastStart, endedAt: pastEnd } });
  const previousEntry = await prisma.meetingProject.create({ data: { teamId: data.teamIds[0], meetingId: previous.id, projectId: data.projectIds[0], position: 0, nameSnapshot: '架空の案件 01' } });
  await prisma.meetingConfirmation.create({ data: { teamId: data.teamIds[0], entryId: previousEntry.id, progress: 40, status: 'IN_PROGRESS', projectVersion: 1,
    confirmedAt: pastStart, confirmedByParticipantId: person.id, confirmedByNameSnapshot: '過去の架空確認者' } });
  await prisma.project.update({ where: { id: data.projectIds[0] }, data: { progress: 60, status: 'REVIEW', version: { increment: 1 } } });
  await click('新しい会議を開始'); await waitFor(bodyHas('全21件 · 確認済み0件 · 未確認21件'), 'targets');
  assert.equal(await evaluate("document.querySelectorAll('#meeting-entry option').length"), 21);
  let meeting = await prisma.meeting.findFirstOrThrow({ where: { teamId: data.teamIds[0], endedAt: null } });
  const entries = await prisma.meetingProject.findMany({ where: { meetingId: meeting.id }, orderBy: { position: 'asc' } });
  await screenshot('meeting-1440'); await fit();
  checks.push('開始時に次ページも含む21案件を表示、確認記録は0件');
  await waitFor(bodyHas('＋20ポイント'), 'delta');
  assert.equal(await evaluate(bodyHas('進捗変更・状態変更')), true);
  assert.equal(await evaluate(bodyHas('比較元：')), true);
  await select('#meeting-entry', entries[1].id); await waitFor(bodyHas('前回の確認記録なし'), 'no-previous');
  assert.equal(await evaluate("[...document.querySelectorAll('[aria-label=\"前回確認からの差分\"] dd')].at(-1).textContent"), '—');
  assert.equal(await evaluate(bodyHas('現在の状態：未着手')), true);
  assert.equal(await evaluate(bodyHas('この会議では未確認です。')), true);
  await width(390); await fit(); await screenshot('meeting-no-previous-390'); await width(1440);
  checks.push('前回記録なし・今回未確認でも現在の状態を表示、増減は—、スマホ幅も維持');
  await select('#meeting-entry', entries[0].id);
  assert.equal(await evaluate(bodyHas('現在の状態：確認待ち')), true);
  assert.equal(await evaluate(bodyHas('状態の比較：進行中 → 確認待ち')), true);
  assert.equal(await evaluate(bodyHas('この会議では未確認です。')), true);
  checks.push('前回記録あり・今回未確認でも現在状態と状態の比較を両方表示');
  checks.push('前回40％→現在60％を＋20ポイント、進捗/状態変更・比較元日時、記録なしを表示');

  phase = 'confirm-resume';
  await click('確認済みにして次へ'); await waitFor(bodyHas('確認済み1件'), 'confirmed');
  assert.equal(await evaluate("document.getElementById('meeting-entry').value"), entries[1].id);
  await send('Page.reload'); await waitFor("!!document.getElementById('team-select')", 'reload');
  await select('#team-select', data.teamIds[0]); await click('会議');
  await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('会議を再開'))", 'resume');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('会議を再開')).click()");
  await waitFor(bodyHas('確認済み1件'), 'resumed');
  assert.equal(await evaluate("document.getElementById('meeting-entry').value"), entries[1].id);
  checks.push('確認後に次へ移動、再読み込み後も同じ会議の記録を再開');

  phase = 'snapshot-poll';
  await select('#meeting-entry', entries[0].id);
  await select('#change-facilitator', '');
  await prisma.project.update({ where: { id: entries[0].projectId }, data: { progress: 80, version: { increment: 1 } } });
  await waitFor(bodyHas('80％'), 'polling');
  assert.equal(await evaluate(bodyHas('確認時：60％')), true);
  assert.equal(await evaluate(bodyHas('確認後に変更あり')), true);
  assert.equal(await evaluate(bodyHas('＋40ポイント')), true);
  assert.equal(await evaluate("document.getElementById('meeting-entry').value"), entries[0].id);
  assert.equal(await evaluate("document.getElementById('change-facilitator').value"), '');
  checks.push('10秒ポーリングで現在値だけ更新し、確認時の値・選択案件・進行役入力を保持');
  await click('確認を取り消す'); await waitFor(bodyHas('確認済み0件'), 'unconfirm');
  assert.equal(await evaluate(bodyHas('現在の状態：確認待ち')), true);
  await click('確認済みにして次へ'); await waitFor(bodyHas('確認済み1件'), 'reconfirm');
  const records = await prisma.meetingConfirmation.findMany({ where: { entryId: entries[0].id } });
  assert.equal(records.length, 2); assert.equal(records.filter(record => record.revokedAt).length, 1);
  assert.equal(records.find(record => !record.revokedAt).progress, 80);
  checks.push('取消履歴を保持し、再確認時は最新80％を新しく保存');

  phase = 'failures-conflict';
  failSave = true; await click('確認済みにして次へ'); await waitFor(bodyHas('検証用の通信失敗'), 'save-fail');
  assert.equal(await evaluate("document.getElementById('meeting-entry').value"), entries[1].id);
  assert.equal(await prisma.meetingConfirmation.count({ where: { entryId: entries[1].id } }), 0);
  failSave = false; await click('確認済みにして次へ'); await waitFor(bodyHas('確認済み2件'), 'retry');
  await prisma.meeting.update({ where: { id: meeting.id }, data: { version: { increment: 1 } } });
  await click('確認済みにして次へ'); await waitFor(bodyHas('会議が更新されています'), 'conflict');
  assert.equal(await evaluate("document.getElementById('meeting-entry').value"), entries[2].id);
  await click('確認済みにして次へ'); await waitFor(bodyHas('確認済み3件'), 'conflict-retry');
  failRead = true; await click('最新の状態を取得'); await waitFor(bodyHas('検証用の通信失敗'), 'read-fail');
  assert.equal(await evaluate(bodyHas('確認済み3件')), true);
  failRead = false; await click('最新の状態を取得'); await waitFor("!document.querySelector('[role=alert]')", 'read-retry');
  checks.push('保存・取得失敗で画面を保持して再試行、409では更新内容を取得してから再操作');

  phase = 'keyboard-finish';
  await width(390); await fit(); await screenshot('meeting-390');
  await click('会議を終了する');
  await waitFor("document.activeElement?.textContent==='会議に戻る'", 'dialog-focus');
  assert.equal(await evaluate("document.querySelectorAll('[role=alertdialog] li').length"), 18);
  await key('Escape', 'Escape', 27); await waitFor("!document.querySelector('[role=alertdialog]')", 'escape');
  await click('会議を終了する'); await waitFor("document.activeElement?.textContent==='会議に戻る'", 'dialog-focus-again');
  await fit(); await screenshot('meeting-finish-390');
  await key('Tab', 'Tab', 9); assert.equal(await evaluate("document.activeElement?.textContent==='記録を残して終了'"), true);
  await key('Enter', 'Enter', 13); await waitFor(bodyHas('終了した会議'), 'ended');
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='確認済みにして次へ')"), false);
  checks.push('390pxで横はみ出しなし、未確認18件一覧・Escape・Tab/Enterで終了、終了後は読み取り専用');

  phase = 'historical-delta';
  await select('#meeting-entry', entries[0].id);
  await prisma.project.update({ where: { id: entries[0].projectId }, data: { progress: 95, status: 'IN_PROGRESS', version: { increment: 1 } } });
  await click('最新の状態を取得'); await waitFor(bodyHas('95％'), 'later-progress');
  assert.equal(await evaluate(bodyHas('＋40ポイント')), true);
  assert.equal(await evaluate(bodyHas('この会議の確認時')), true);
  assert.equal(await evaluate(bodyHas('この会議の確認時の状態：確認待ち')), true);
  assert.equal(await evaluate(bodyHas('現在の案件（会議後の更新を含む）：95％ · 進行中')), true);
  assert.equal(await evaluate(bodyHas('現在の状態：')), false);
  await fit(); await screenshot('meeting-history-390');
  await select('#meeting-entry', entries[3].id); await waitFor(bodyHas('この会議では未確認'), 'historical-unconfirmed');
  assert.equal(await evaluate(bodyHas('この会議の確認時の状態：')), false);
  assert.equal(await evaluate(bodyHas('現在の案件（会議後の更新を含む）：0％ · 未着手')), true);
  assert.equal(await evaluate("[...document.querySelectorAll('[aria-label=\"前回確認からの差分\"] dd')].at(-1).textContent"), '—');
  checks.push('終了済みの確認時状態と現在状態を分離、未確認の当時状態は推測しない');
  checks.push('会議終了後の現在95％と当時80％を分離し差分＋40を保持、未確認の当時値は推測しない');

  phase = 'new-meeting-team';
  await click('会議一覧に戻る'); await click('新しい会議を開始'); await waitFor(bodyHas('全21件 · 確認済み0件 · 未確認21件'), 'new-meeting');
  await select('#team-select', data.teamIds[1]); await click('会議'); await waitFor(bodyHas('会議はまだありません。'), 'other-team');
  assert.equal(await evaluate("document.body.textContent.includes('確認済み3件')"), false);
  checks.push('次の会議は確認0件で開始し、チーム切替で前チームの会議を表示しない');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ status: 'passed', checks }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase, reason: String(error?.message ?? error).replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 120) })); process.exitCode = 1;
} finally {
  if (ws) ws.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); }); }
  if (data) { await removeLocalWorkspaceData(prisma, data); fs.rmSync(path.join(output, 'fixture.json'), { force: true }); } await prisma.$disconnect();
  const resolved = path.resolve(profile), parent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('siteflow-meeting-chrome-')) throw Error('PROFILE_SCOPE_FAILED');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}
