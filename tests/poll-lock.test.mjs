import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLocalLock, releaseLocalLock, assertLocalLock, retainLocalLock, assertLocalDirectory, writeExclusiveLocal, readLocalFile } from '../deploy/poll/lock.mjs';
const ownedChildren = new WeakMap();
function registerChild(child) {
  assert.equal(child.spawnfile, process.execPath);
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid !== process.pid);
  ownedChildren.set(child, child.pid); return child;
}
function killOwnedChild(child) {
  assert.ok(ownedChildren.has(child));
  assert.equal(ownedChildren.get(child), child.pid); assert.equal(child.spawnfile, process.execPath);
  // Nodeが保持する子プロセス参照だけを使う。終了済み/送信済みなら再送せず、
  // 古い数値PIDをprocess.killへ渡さない（PID再利用で他プロセスを狙わない）。
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return false;
  return child.kill('SIGKILL');
}

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), 'siteflow-poll-stage5-')); }
function cleanup(root) {
  const real = fs.realpathSync(root);
  assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(real), /^siteflow-poll-stage5-[a-zA-Z0-9]+$/);
  fs.rmSync(real, { recursive: true, force: true });
}
function local(name, run) { test(name, () => { const root = workspace(); try { run(root); } finally { cleanup(root); } }); }
local('lock: same-process competing acquire is refused', root => {
  const h = acquireLocalLock(root); assert.throws(() => acquireLocalLock(root), /EEXIST/);
  assert.equal(h.executionAllowed, false); releaseLocalLock(h);
  const next = acquireLocalLock(root); releaseLocalLock(next);
});
local('lock: forged handle cannot release another owner', root => {
  const h = acquireLocalLock(root); assert.throws(() => releaseLocalLock({}), /MANUAL_REVIEW/);
  assertLocalLock(h, root); releaseLocalLock(h);
});
local('lock: PID reuse does not establish ownership', root => {
  const h = acquireLocalLock(root), p = path.join(root, 'release.lock', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(p)); owner.pid = process.pid; owner.nonce = 'different';
  fs.writeFileSync(p, JSON.stringify(owner));
  assert.throws(() => releaseLocalLock(h), /OWNER_CHANGED/);
  assert.throws(() => acquireLocalLock(root), /EEXIST/);
});
local('lock: incomplete stale lock is never reclaimed', root => {
  fs.mkdirSync(path.join(root, 'release.lock'));
  assert.throws(() => acquireLocalLock(root), /EEXIST/);
});
local('lock: sticky incident lock requires manual review', root => {
  const h = acquireLocalLock(root); retainLocalLock(h);
  assert.throws(() => releaseLocalLock(h), /MANUAL_REVIEW/);
});
local('lock: replaced lock directory cannot be released', root => {
  const h = acquireLocalLock(root);
  fs.renameSync(path.join(root, 'release.lock'), path.join(root, 'old.lock'));
  fs.mkdirSync(path.join(root, 'release.lock'));
  fs.writeFileSync(path.join(root, 'release.lock', 'owner.json'), '{}');
  assert.throws(() => releaseLocalLock(h));
});
test('lock: production/repository paths are refused', () => {
  assert.throws(() => assertLocalDirectory(process.cwd()), /LOCAL_TEST_PATH_REQUIRED/);
  assert.throws(() => writeExclusiveLocal(path.join(process.cwd(), 'forbidden.json'), '{}'), /LOCAL_TEST_PATH_REQUIRED/);
});
test('lock: actual separate process holds lock, SIGKILL leaves blocking lock', { timeout: 15000 }, async () => {
  const root = workspace(); let child;
  try {
    const url = new URL('../deploy/poll/lock.mjs', import.meta.url).href;
    child = registerChild(spawn(process.execPath, ['--input-type=module', '-e', `import {acquireLocalLock} from ${JSON.stringify(url)}; acquireLocalLock(${JSON.stringify(root)}); console.log('HELD'); setInterval(()=>{},1000);`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    const closed = once(child, 'close');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CHILD_TIMEOUT')), 5000);
      child.stdout.once('data', data => { clearTimeout(timer); if (data.toString().includes('HELD')) resolve(); else reject(new Error('CHILD_NOT_READY')); });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error('CHILD_EXITED_EARLY')); });
    });
    assert.throws(() => acquireLocalLock(root), /EEXIST/);
    killOwnedChild(child); await closed;
    assert.throws(() => acquireLocalLock(root), /EEXIST/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); killOwnedChild(child); await closed; }
    cleanup(root);
  }
});
local('lock: hard-linked state files are refused', root => {
  const original = path.join(root, 'original.json'), alias = path.join(root, 'alias.json');
  writeExclusiveLocal(original, '{}'); fs.linkSync(original, alias);
  assert.throws(() => readLocalFile(alias), /UNSAFE_LOCAL_FILE/);
});
local('lock: directory junction cannot substitute local workspace', root => {
  const link = path.join(root, 'junction'); fs.symlinkSync(root, link, 'junction');
  assert.throws(() => assertLocalDirectory(link), /UNSAFE_LOCAL_DIRECTORY/);
});
test('lock: actual simultaneous child processes have exactly one owner', { timeout: 15000 }, async () => {
  const root = workspace(), children = [];
  try {
    const url = new URL('../deploy/poll/lock.mjs', import.meta.url).href;
    const ready = children;
    for (let i = 0; i < 2; i++) {
      const code = `import {acquireLocalLock} from ${JSON.stringify(url)}; process.stdin.once('data',()=>{try{acquireLocalLock(${JSON.stringify(root)});console.log('OWNED')}catch{console.log('BUSY')}setInterval(()=>{},1000)});console.log('READY');`;
      const child = registerChild(spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
      ready.push(child);
    }
    const output = children.map(child => new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('CHILD_TIMEOUT')), 5000);
      child.once('error', reject);
      child.stdout.on('data', bytes => {
        text += bytes.toString();
        if (text.includes('READY') && !child.started) { child.started = true; }
        if (text.includes('OWNED') || text.includes('BUSY')) { clearTimeout(timer); resolve(text.includes('OWNED') ? 'OWNED' : 'BUSY'); }
      });
    }));
    // Both are started before the same acquisition signal. mkdir arbitrates in the OS.
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (children.every(c => c.started)) { clearInterval(interval); resolve(); }
        else if (Date.now() - started > 5000) { clearInterval(interval); reject(new Error('READY_TIMEOUT')); }
      }, 5);
    });
    for (const child of children) child.stdin.write('go');
    assert.deepEqual((await Promise.all(output)).sort(), ['BUSY', 'OWNED']);
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); killOwnedChild(child); await closed; }
    }));
    cleanup(root);
  }
});
