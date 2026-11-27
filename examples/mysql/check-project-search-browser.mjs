import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// 実Chrome・実React画面を検証する。応答はすべて架空で、DB・本番・認証情報には接続しない。
const base = process.env.SITEFLOW_SEARCH_BROWSER_ORIGIN ?? 'http://127.0.0.1:5187';
const origin = new URL(base);
if (origin.origin !== base || origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || !origin.port) throw new Error('LOCAL_BROWSER_ONLY');
const output = path.resolve('work/project-search'); fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-search-chrome-'));
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const team = id(1), emptyTeam = id(2), user = id(3);
const members = Array.from({ length: 25 }, (_, i) => ({ userId: id(i + 100), name: `架空の担当${i + 1}`, role: 'member' }));
const projects = Array.from({ length: 25 }, (_, i) => ({ id: id(i + 1000), name: i === 0 ? '橋梁 100%_確認' : `架空の案件 ${i + 1}`, code: `LOCAL-${i + 1}`, dueDate: '2026-12-31', status: i === 0 ? 'REVIEW' : 'IN_PROGRESS', progress: i === 0 ? 0 : 40, primaryAssignee: { name: members[0].name }, primaryUserId: members[0].userId, supportUserId: members[24].userId }));
let child, ws, send, phase = 'startup'; const checks = []; const pending = new Map(); const held = [];
let holdSlow = false, failMode = false; let memberPageTwo = false;
try {
  child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100; i++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(port, 'Chrome起動');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++serial; const timeout = setTimeout(() => { pending.delete(key); reject(new Error('CDP_TIMEOUT')); }, 20000);
    pending.set(key, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: () => { clearTimeout(timeout); reject(new Error('CDP_FAILED')); } });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const fulfill = (requestId, body, code = 200) => send('Fetch.fulfillRequest', { requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  async function respond(event) {
    const url = new URL(event.request.url), route = url.pathname.replace('/api/siteflow/', ''); const q = url.searchParams;
    if (route === 'auth/get-session') return fulfill(event.requestId, { user: { id: user, name: '架空の体験ユーザー', email: 'fixture@example.invalid' } });
    if (route === 'teams') return fulfill(event.requestId, { items: [{ id: team, name: '架空の青葉チーム', role: 'admin' }, { id: emptyTeam, name: '架空の空チーム', role: 'admin' }], page: { hasMore: false, nextCursor: null } });
    if (route.endsWith('/members')) {
      const second = q.has('cursor'); if (second) memberPageTwo = true;
      return fulfill(event.requestId, { items: second ? members.slice(20) : members.slice(0, 20), page: { hasMore: !second, nextCursor: second ? null : members[19].userId } });
    }
    if (/\/(projects|archived-projects)$/.test(route)) {
      if (q.get('q') === 'slow' && holdSlow) { held.push(event.requestId); return; }
      if (failMode) return fulfill(event.requestId, { message: '検証用の取得失敗' }, 503);
      const collection = route.includes(emptyTeam) || route.endsWith('/archived-projects') ? [] : projects;
      const rows = collection.filter(p => (!q.get('q') || (p.name + p.code).includes(q.get('q')))
        && (!q.get('primaryUserId') || p.primaryUserId === q.get('primaryUserId'))
        && (!q.get('supportUserId') || p.supportUserId === q.get('supportUserId'))
        && (!q.get('status') || p.status === q.get('status'))
        && (!q.has('progressMin') || p.progress >= Number(q.get('progressMin')))
        && (!q.has('progressMax') || p.progress <= Number(q.get('progressMax'))));
      const start = q.has('cursor') ? rows.findIndex(p => p.id === q.get('cursor')) + 1 : 0;
      const items = rows.slice(start, start + 20), hasMore = start + 20 < rows.length;
      return fulfill(event.requestId, { items, total: rows.length, collectionTotal: collection.length, page: { hasMore, nextCursor: hasMore ? items.at(-1).id : null } });
    }
    if (route.endsWith('/access')) return fulfill(event.requestId, { team: { id: team, name: '架空の青葉チーム' }, role: 'admin' });
    return fulfill(event.requestId, { message: '模擬対象外の操作' }, 404);
  }
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(); else p.resolve(m.result); }
    if (m.method === 'Fetch.requestPaused') void respond(m.params).catch(() => {});
  };
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('BROWSER_EXPRESSION_FAILED'); return r.result.value;
  };
  const wait = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('UI_TIMEOUT'); };
  const input = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  const click = text => evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}&&e.offsetParent!==null);if(!e)throw Error('BUTTON');e.click();})()`);
  const count = n => wait(`document.querySelectorAll('[data-project-id]').length===${n}&&![...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('案件を読み込んで'))`);
  const search = async q => { await input('#project-keyword', q); await click('検索'); };
  await send('Fetch.enable', { patterns: [{ urlPattern: base + '/api/siteflow/*', requestStage: 'Request' }] });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: base + '/workspace' });
  phase = 'initial'; await count(20); assert.equal(await evaluate("document.body.textContent.includes('検索結果 25件・20件表示中')"), true); checks.push('初期20件・総件数25件');
  await click('続きを読み込む'); await count(25); checks.push('同条件で続きを取得');
  phase = 'search'; await search('100%_'); await count(1);
  assert.equal(await evaluate("new URLSearchParams(location.search).get('q')"), '100%_'); checks.push('検索でページリセット・URLエンコード');
  await send('Page.reload', { ignoreCache: true }); await count(1); assert.equal(await evaluate("document.querySelector('#project-keyword').value"), '100%_'); checks.push('URLから検索条件を復元');
  phase = 'members'; await evaluate("document.querySelector('details').open=true"); await click('担当者候補をさらに表示');
  await wait("document.querySelectorAll('#search-support option').length===26"); assert.equal(memberPageTwo, true);
  await input('#search-primary', members[0].userId); await input('#search-support', members[24].userId); await input('#search-status', 'REVIEW'); await input('#search-min', '0'); await input('#search-max', '0'); await click('検索'); await count(1); checks.push('候補2ページ目・主副担当・状態・進捗0の複合条件');
  phase = 'empty'; await search('not-found'); await count(0); await wait("document.body.textContent.includes('条件に一致する案件はありません')"); checks.push('検索0件を表示');
  await click('条件をリセット'); await count(20); assert.equal(await evaluate("new URLSearchParams(location.search).has('q')"), false); checks.push('全条件リセット');
  phase = 'history'; await search('LOCAL-2'); await count(7); await evaluate('history.back()'); await count(20); await evaluate('history.forward()'); await count(7); checks.push('戻る・進むで条件と結果を復元');
  phase = 'failure'; failMode = true; await search('失敗'); await wait("document.body.textContent.includes('検証用の取得失敗')"); assert.equal(await evaluate("document.querySelector('#project-keyword').value"), '失敗'); failMode = false; await click('案件を再取得する'); await count(0); checks.push('取得失敗・入力保持・再試行');
  phase = 'race'; holdSlow = true; await search('slow'); await wait('document.body.textContent.includes("案件を読み込んでいます")'); await search('LOCAL-1'); await count(11);
  holdSlow = false; for (const requestId of held) await fulfill(requestId, { items: [], total: 0, collectionTotal: 25, page: { hasMore: false, nextCursor: null } }).catch(() => {});
  await new Promise(r => setTimeout(r, 200)); await count(11); checks.push('古い検索応答が新しい結果を上書きしない');
  phase = 'team'; await input('#team-select', emptyTeam); await count(0); await wait("document.body.textContent.includes('このチームの案件はまだありません')"); assert.equal(await evaluate("new URLSearchParams(location.search).has('q')"), false); checks.push('チーム切替で条件を解除・未登録を区別');
  await evaluate('history.back()'); await count(11); checks.push('戻る操作でチームと条件を復元');
  phase = 'screenshots'; for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await evaluate("document.querySelector('details').open=true;window.scrollTo(0,document.querySelector('#projects-title').getBoundingClientRect().top+scrollY-20)"); await new Promise(r => setTimeout(r, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, '横はみ出しなし');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(output, `search-${width}.png`), Buffer.from(shot.data, 'base64'));
  } checks.push('1440/390幅・詳細条件・横はみ出し・画像保存');
  phase = 'keyboard'; await evaluate("document.querySelector('#project-keyword').focus()"); await input('#project-keyword', '100%_');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await count(1); checks.push('キーボードEnterで検索');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ mode: 'mock-api-real-chrome', checks, passed: true }, null, 2));
  console.log(`PASS ${checks.length} real Chrome checks (mock API; no database)`);
} catch {
  console.error('BROWSER_CHECK_FAILED: ' + phase); process.exitCode = 1;
  if (send && ws?.readyState === WebSocket.OPEN) { const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).catch(() => null); if (shot) fs.writeFileSync(path.join(output, 'failure.png'), Buffer.from(shot.data, 'base64')); }
} finally {
  if (send && ws?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); ws.close(); }
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  for (const p of pending.values()) p.reject(); pending.clear();
  if (profile.startsWith(path.join(os.tmpdir(), 'siteflow-search-chrome-'))) await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
}
