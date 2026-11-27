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

// 実Chrome → 実Next.js API → 固定RSA鍵 → 専用MySQL。応答の差し替えなし。
const base = process.env.SITEFLOW_SEARCH_BROWSER_ORIGIN ?? 'http://127.0.0.1:5187';
const origin = new URL(base);
if (origin.origin !== base || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('LOCAL_ONLY');
const settings = readSchemaCheckSettings();
const prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...readSchemaCheckConnectionOptions(), connectionLimit: 2 }) });
const output = path.resolve('work/project-search-real'); fs.mkdirSync(output, { recursive: true });
let data, outsider, child, ws, send, profile, before;
let phase = 'preflight', completed = false, cleanupVerified = false;
const extraUsers = [], checks = [], pending = new Map(); let apiResponses = 0, loginResponses = 0;
async function snapshot() {
  const tables = {};
  for (const table of ['Team', 'TeamMembership', 'TeamParticipant', 'Project', 'ProjectSupportMember', 'ProjectProgressHistory', 'ProjectAssignmentHistory', 'Meeting', 'MeetingProject', 'MeetingConfirmation', 'user', 'account', 'session']) {
    const rows = await prisma.$queryRawUnsafe('SELECT ' + (['user', 'account', 'session'].includes(table) ? 'id' : '*') + ' FROM `' + table + '`');
    const serialized = rows.map(row => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value)).sort();
    tables[table] = { count: rows.length, hash: createHash('sha256').update(JSON.stringify(serialized)).digest('hex') };
  }
  return tables;
}
try {
  const [actual] = await prisma.$queryRawUnsafe('SELECT DATABASE() AS db, CURRENT_USER() AS principal');
  assert.ok(actual.db === settings.database && actual.principal.split('@')[0] === settings.user, '専用DB照合');
  before = await snapshot();
  data = await createLocalWorkspaceData(prisma); outsider = await createLocalWorkspaceData(prisma);
  const team = data.teamIds[0], emptyTeam = data.teamIds[1], target = data.projectIds[0];
  const owner = await prisma.teamParticipant.findFirstOrThrow({ where: { teamId: team, userId: data.userId } });
  for (let i = 0; i < data.projectIds.length; i++) await prisma.project.update({ where: { id: data.projectIds[i] }, data: { name: i === 0 ? '橋梁 100%_確認' : `通し確認の案件 ${i + 1}`, code: `REAL-${String(i + 1).padStart(3, '0')}`, progress: i === 0 ? 0 : 40, status: i === 0 ? 'REVIEW' : 'IN_PROGRESS' } });
  for (let i = 22; i <= 25; i++) await prisma.project.create({ data: { id: randomUUID(), teamId: team, name: `通し確認の案件 ${i}`, code: `REAL-${String(i).padStart(3, '0')}`, dueDate: new Date('2026-12-31'), primaryParticipantId: owner.id, createdByParticipantId: owner.id, createdByNameSnapshot: '架空の作成者', progress: 40, status: 'IN_PROGRESS' } });
  const users = Array.from({ length: 24 }, (_, i) => ({ id: randomUUID(), name: `架空の候補 ${i + 1}`, emailVerified: true }));
  extraUsers.push(...users.map(user => user.id));
  await prisma.user.createMany({ data: users.map(user => ({ ...user, email: user.id + '@example.invalid' })) });
  await prisma.teamMembership.createMany({ data: users.map(user => ({ id: randomUUID(), teamId: team, userId: user.id, role: 'member', createdAt: new Date() })) });
  const allMembers = await prisma.teamMembership.findMany({ where: { teamId: team }, orderBy: { userId: 'asc' }, select: { userId: true } });
  const supportUser = allMembers.slice(20).find(member => member.userId !== data.userId).userId;
  const support = await prisma.teamParticipant.create({ data: { teamId: team, userId: supportUser } });
  await prisma.projectSupportMember.create({ data: { teamId: team, projectId: target, participantId: support.id } });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-search-real-'));
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
    if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(base + '/api/siteflow/')) { apiResponses++; if (m.params.response.url.endsWith('/auth/sign-in/email') && m.params.response.status === 200) loginResponses++; }
  };
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('BROWSER_EXPRESSION'); return r.result.value; };
  const wait = async expression => { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('UI_TIMEOUT'); };
  const input = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  const click = async text => { const selector = `[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}&&e.offsetParent!==null&&!e.disabled)`; await wait(`!!(${selector})`); await evaluate(`(${selector}).click()`); };
  const count = n => wait(`document.querySelectorAll('[data-project-id]').length===${n}&&![...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('案件を読み込んで'))`);
  const search = async q => { await input('#project-keyword', q); await click('検索'); };
  const allCandidates = async () => { await evaluate("document.querySelector('details').open=true"); await wait("document.querySelectorAll('#search-support option').length>=21"); if (await evaluate("[...document.querySelectorAll('button')].some(e=>e.textContent==='担当者候補をさらに表示')")) await click('担当者候補をさらに表示'); await wait("document.querySelectorAll('#search-support option').length===26"); };
  await send('Page.enable'); await send('Network.enable');
  await send('Page.navigate', { url: base + '/workspace' });
  phase = 'login'; await wait("!!document.querySelector('#login-email')");
  await input('#login-email', data.email); await input('#login-password', data.password); await click('ログイン');
  await wait("!!document.querySelector('#team-select')"); await input('#team-select', team); await count(20);
  assert.ok(loginResponses > 0, '実ログインAPI200');
  const cookies = (await send('Network.getCookies', { urls: [base + '/api/siteflow/auth/get-session'] })).cookies;
  assert.ok(cookies.some(c => c.httpOnly && c.path === '/api/siteflow'), '実認証Cookie');
  checks.push('実ログイン・HttpOnly Cookie・専用MySQL');
  phase = 'pagination'; await wait("document.body.textContent.includes('検索結果 25件・20件表示中')"); await click('続きを読み込む'); await count(25);
  assert.equal(await evaluate("new Set([...document.querySelectorAll('[data-project-id]')].map(e=>e.dataset.projectId)).size"), 25); checks.push('総件数25・20件からの追加取得・重複なし');
  phase = 'keyword'; await search('100%_'); await count(1); assert.equal(await evaluate(`document.querySelector('[data-project-id]').dataset.projectId===${JSON.stringify(target)}`), true);
  await search('REAL-025'); await count(1); checks.push('実MySQLの案件名・番号・特殊文字検索');
  phase = 'combination'; await search('橋梁'); await count(1); await allCandidates(); await input('#search-primary', data.userId); await input('#search-support', supportUser); await input('#search-status', 'REVIEW'); await input('#search-min', '0'); await input('#search-max', '0'); await click('検索'); await count(1); checks.push('候補2ページ目と主副担当・状態・進捗のAND検索');
  phase = 'restore'; await send('Page.reload', { ignoreCache: true }); await count(1); assert.equal(await evaluate("document.querySelector('#search-min').value"), '0'); checks.push('再読込でURLの複合条件を復元');
  phase = 'screens'; await allCandidates();
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 390 });
    await evaluate("document.querySelector('details').open=true;window.scrollTo(0,document.querySelector('#projects-title').getBoundingClientRect().top+scrollY-20)"); await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, '横はみ出しなし');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, `search-${width}.png`), Buffer.from(shot.data, 'base64'));
  } checks.push('PC1440・スマホ390の複合検索と画像保存');
  phase = 'empty-reset'; await search('存在しない案件'); await count(0); await wait("document.body.textContent.includes('条件に一致する案件はありません')"); await click('条件をリセット'); await count(20); checks.push('検索0件と全条件リセット');
  phase = 'history'; await search('REAL-02'); await count(6); await evaluate('history.back()'); await count(20); await evaluate('history.forward()'); await count(6); checks.push('戻る・進むとページ先頭の復元');
  phase = 'team'; await input('#team-select', emptyTeam); await count(0); await wait("document.body.textContent.includes('このチームの案件はまだありません')"); assert.equal(await evaluate("new URLSearchParams(location.search).has('q')"), false); await evaluate('history.back()'); await count(6); checks.push('チーム切替・未登録・条件解除・戻るで復元');
  phase = 'separation'; assert.equal(await evaluate(`fetch('/api/siteflow/teams/${outsider.teamIds[0]}/projects').then(r=>r.status)`), 403); checks.push('実セッションで他チームのAPIを拒否');
  phase = 'edit'; await search('100%_'); await count(1); await evaluate(`document.querySelector('[data-project-id="${target}"] button').click()`); await wait("!!document.querySelector('[data-project-detail]')"); await click('基本情報を編集'); await wait("!!document.querySelector('#edit-name')"); const edited = '橋梁 100%_確認 保存済み'; await input('#edit-name', edited); await click('変更を保存する'); await wait("!!document.querySelector('[data-project-detail]')");
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: target } })).name, edited); await click('一覧へ戻る'); await count(1); await wait(`document.querySelector('[data-project-id]').textContent.includes(${JSON.stringify(edited)})`); checks.push('検索から詳細編集・実DB保存・一覧再取得');
  phase = 'meeting'; await click('条件をリセット'); await count(20); await click('会議'); await wait("!!document.querySelector('#meetings-title')"); await click('新しい会議を開始'); await wait("document.querySelectorAll('#meeting-entry option').length===25");
  const meeting = await prisma.meeting.findFirstOrThrow({ where: { teamId: team } }); const entry = await prisma.meetingProject.findFirstOrThrow({ where: { meetingId: meeting.id, projectId: target } });
  phase = 'meeting-confirm'; await input('#meeting-entry', entry.id); await wait(`document.querySelector('#meeting-project-title').textContent===${JSON.stringify(edited)}`); await click('確認済みにして次へ');
  for (let i = 0; i < 80 && await prisma.meetingConfirmation.count({ where: { entryId: entry.id, revokedAt: null } }) !== 1; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await prisma.meetingConfirmation.count({ where: { entryId: entry.id, revokedAt: null } }), 1);
  await wait("document.querySelector('#meeting-entry')?.disabled===false&&document.body.textContent.includes('確認済み1件')");
  phase = 'meeting-unconfirm'; await input('#meeting-entry', entry.id); await wait(`document.querySelector('#meeting-project-title').textContent===${JSON.stringify(edited)}`); await click('確認を取り消す'); await wait("document.body.textContent.includes('未確認25')&&document.querySelector('#meeting-entry')?.disabled===false");
  phase = 'meeting-finish'; await click('会議を終了する'); await click('記録を残して終了'); await wait("document.querySelector('#meeting-title')?.textContent==='終了した会議'");
  assert.ok((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).endedAt); assert.equal(await prisma.meetingConfirmation.count({ where: { entryId: entry.id, revokedAt: { not: null } } }), 1); checks.push('会議25案件・確認・取消監査・終了の実DB保存');
  await click('通常の案件'); await count(20); await click('保管一覧'); await count(0); await wait("document.body.textContent.includes('保管した案件はまだありません')"); await click('通常の案件'); await count(20); checks.push('会議・通常・保管一覧間の切替');
  phase = 'keyboard'; await evaluate("document.querySelector('#project-keyword').focus()"); await input('#project-keyword', 'REAL-025'); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await count(1); checks.push('スマホ幅・Enterで実検索');
  phase = 'logout'; await click('ログアウト'); await wait("!!document.querySelector('#login-email')"); assert.equal(await evaluate("fetch('/api/siteflow/teams').then(r=>r.status)"), 401); checks.push('ログアウト後の実API拒否');
  assert.ok(apiResponses > 30, '応答を差し替えず実APIを使用'); completed = true;
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
  if (profile && profile.startsWith(path.join(os.tmpdir(), 'siteflow-search-real-'))) await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
  try {
    if (data) await removeLocalWorkspaceData(prisma, data); if (outsider) await removeLocalWorkspaceData(prisma, outsider);
    if (extraUsers.length) await prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    if (before) { assert.deepEqual(await snapshot(), before, '既存データの前後一致'); cleanupVerified = true; }
  } catch { console.error('FIXTURE_CLEANUP_OR_FINGERPRINT_FAILED'); process.exitCode = 1; }
  await prisma.$disconnect();
}
if (completed && cleanupVerified && !process.exitCode) {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ mode: 'real-mysql-next-api-chrome', checks, apiResponses, cleanupVerified, passed: true }, null, 2));
  console.log(`PASS ${checks.length} real MySQL/Next.js/Chrome checks; cleanup verified`);
}
