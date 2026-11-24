import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { need } from './contract.mjs';

// 第5段階はOS一時領域のローカル試験専用。本番EBS用adapterではない。
const held = new WeakMap();
const processIdentity = randomBytes(32).toString('hex');
const lockNames = new Set(['release.lock', 'nginx.lock']);
export function assertLocalDirectory(directory) {
  const resolved = path.resolve(directory), base = fs.realpathSync(os.tmpdir());
  const s = fs.lstatSync(resolved);
  need(s.isDirectory() && !s.isSymbolicLink(), 'UNSAFE_LOCAL_DIRECTORY');
  const real = fs.realpathSync(resolved);
  need(path.dirname(real) === base && /^siteflow-poll-stage5-[a-zA-Z0-9]+$/.test(path.basename(real)), 'LOCAL_TEST_PATH_REQUIRED');
  if (process.platform !== 'win32') need(s.uid === process.getuid() && (s.mode & 0o077) === 0, 'UNSAFE_LOCAL_DIRECTORY_MODE');
  return real;
}
export function syncLocalDirectory(directory) {
  if (lockNames.has(path.basename(directory))) {
    assertLocalDirectory(path.dirname(directory));
    const s = fs.lstatSync(directory);
    need(s.isDirectory() && !s.isSymbolicLink(), 'UNSAFE_LOCK_DIRECTORY');
  }
  else assertLocalDirectory(directory);
  if (process.platform === 'win32') return false; // Windowsで親dirの耐電断性は証明しない。
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}
export function readLocalFile(file, limit = 262144) {
  assertLocalFilePath(file);
  const s = fs.lstatSync(file);
  need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= limit, 'UNSAFE_LOCAL_FILE');
  if (process.platform !== 'win32') need(s.uid === process.getuid() && (s.mode & 0o077) === 0, 'UNSAFE_LOCAL_FILE_MODE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    need(opened.dev === s.dev && opened.ino === s.ino && opened.size <= limit, 'LOCAL_FILE_REPLACED');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    need(bytes.length <= limit && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs, 'LOCAL_FILE_CHANGED_DURING_READ');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { fs.closeSync(fd); }
}
export function writeExclusiveLocal(file, text) {
  assertLocalFilePath(file);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function assertLocalFilePath(file) {
  const parent = path.dirname(path.resolve(file));
  if (lockNames.has(path.basename(parent))) {
    assertLocalDirectory(path.dirname(parent));
    const s = fs.lstatSync(parent);
    need(s.isDirectory() && !s.isSymbolicLink(), 'UNSAFE_LOCK_DIRECTORY');
    need(path.basename(file) === 'owner.json', 'UNSAFE_LOCAL_FILE_PATH');
  } else assertLocalDirectory(parent);
}
export function acquireLocalLock(directory) {
  return acquire(directory, 'release.lock');
}
export function acquireLocalConfigLock(directory) {
  return acquire(directory, 'nginx.lock');
}
function acquire(directory, kind) {
  const root = assertLocalDirectory(directory), rootStat = fs.lstatSync(root);
  const lock = path.join(root, kind);
  // mkdirはプロセス間で競合する。残存・不完全ロックもEEXISTで拒否する。
  fs.mkdirSync(lock, { mode: 0o700 });
  const nonce = randomBytes(32).toString('hex');
  const owner = JSON.stringify({ version: 1, pid: process.pid, processIdentity, nonce });
  // ここで失敗してもロックを勝手に消さない。所有権不明として残す。
  writeExclusiveLocal(path.join(lock, 'owner.json'), owner);
  syncLocalDirectory(lock); syncLocalDirectory(root);
  const lockStat = fs.lstatSync(lock), ownerStat = fs.lstatSync(path.join(lock, 'owner.json'));
  const handle = Object.freeze({ mode: 'local-test-only', executionAllowed: false });
  held.set(handle, { root, rootStat, lock, lockStat, ownerStat, owner, kind, sticky: false, released: false });
  return handle;
}
export function assertLocalLock(handle, directory) {
  return assertOwned(handle, directory, 'release.lock');
}
export function assertLocalConfigLock(handle, directory) {
  return assertOwned(handle, directory, 'nginx.lock');
}
function assertOwned(handle, directory, kind) {
  const h = held.get(handle);
  need(h && !h.released && h.kind === kind && h.root === assertLocalDirectory(directory), 'LOCAL_LOCK_NOT_OWNED');
  const root = fs.lstatSync(h.root), s = fs.lstatSync(h.lock), o = fs.lstatSync(path.join(h.lock, 'owner.json'));
  need(root.dev === h.rootStat.dev && root.ino === h.rootStat.ino && s.isDirectory() && !s.isSymbolicLink() &&
    s.dev === h.lockStat.dev && s.ino === h.lockStat.ino && o.dev === h.ownerStat.dev && o.ino === h.ownerStat.ino &&
    readLocalFile(path.join(h.lock, 'owner.json'), 4096) === h.owner, 'LOCAL_LOCK_OWNER_CHANGED');
  return h.root;
}
export function retainLocalLock(handle) {
  const h = held.get(handle); need(h && !h.released, 'LOCAL_LOCK_NOT_OWNED'); h.sticky = true;
}
export function releaseLocalLock(handle) {
  const h = held.get(handle); need(h && !h.sticky, 'LOCAL_LOCK_REQUIRES_MANUAL_REVIEW');
  assertOwned(handle, h.root, h.kind);
  fs.unlinkSync(path.join(h.lock, 'owner.json')); fs.rmdirSync(h.lock); syncLocalDirectory(h.root);
  h.released = true;
}
