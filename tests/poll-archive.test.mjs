import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { readReleaseArchive } from '../deploy/poll/archive.mjs';

const record = () => ({ schemaVersion: 1, repository: 'syucream02/siteflow', workflow: '.github/workflows/ci.yml',
  sha: 'a'.repeat(40), runId: '101', attempt: '1', imageRepository: 'ghcr.io/syucream02/siteflow',
  digest: `sha256:${'b'.repeat(64)}`, migrationDigest: `sha256:${'c'.repeat(64)}`, schemaHash: 'd'.repeat(64), approved: true });
// これは試験用ZIPの生成器。ZIPの読取・解釈は本体もテストもyauzlに任せる。
function zip(entries = [{}]) {
  const locals = [], central = []; let offset = 0;
  for (const o of entries) {
    const name = Buffer.from(o.name ?? 'approved-release.json'), localName = Buffer.from(o.localName ?? name);
    const data = o.data ?? Buffer.from(JSON.stringify(record(), null, 2));
    const method = o.method ?? 8, compressed = method === 0 ? data : deflateRawSync(data);
    const flags = o.flags ?? (o.descriptor ? 8 : 0), checksum = o.checksum ?? crc32(data), size = o.size ?? data.length;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4);
    l.writeUInt16LE(o.localFlags ?? flags, 6); l.writeUInt16LE(o.localMethod ?? method, 8);
    l.writeUInt32LE(o.descriptor ? 0 : checksum, 14); l.writeUInt32LE(o.descriptor ? 0 : compressed.length, 18);
    l.writeUInt32LE(o.descriptor ? 0 : size, 22); l.writeUInt16LE(localName.length, 26);
    let descriptor = Buffer.alloc(0);
    if (o.descriptor) { descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12); }
    const body = Buffer.concat([l, localName, compressed, descriptor]); locals.push(body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(o.attributes ?? 0x81a40000, 38); c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, name])); offset += body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const metadata = bytes => ({ size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
test('メモリ内ZIPのJSONそのものを取得し、書込み・実行許可を行わない', async () => {
  const bytes = zip(), before = Buffer.from(bytes), result = await readReleaseArchive(bytes, metadata(bytes));
  assert.deepEqual(result.record, record()); assert.deepEqual(JSON.parse(result.jsonBytes), record());
  assert.equal(result.executionAllowed, false); assert.deepEqual(bytes, before);
});
test('stored/deflateと正当なデータ記述子を受け入れる', async () => {
  for (const o of [{ method: 0 }, { method: 8 }, { descriptor: true }, { method: 0, descriptor: true }]) {
    const b = zip([o]); assert.deepEqual((await readReleaseArchive(b, metadata(b))).record, record());
  }
});
for (const [name, entries] of [
  ['空ZIP', []], ['重複', [{}, {}]], ['パス逸脱', [{ name: '../approved-release.json' }]],
  ['絶対パス', [{ name: '/approved-release.json' }]], ['Windowsパス', [{ name: 'C:\\approved-release.json' }]],
  ['別名', [{ name: 'other.json' }]], ['symlink', [{ attributes: 0xa1ff0000 }]],
  ['directory属性', [{ attributes: 0x10 }]], ['暗号化', [{ flags: 1 }]], ['強い暗号化', [{ flags: 64 }]],
  ['未対応フラグ', [{ flags: 32 }]], ['storedの圧縮フラグ矛盾', [{ method: 0, flags: 2 }]],
  ['不正方式', [{ method: 9 }]], ['local名不一致', [{ localName: 'different-release.json' }]],
  ['localフラグ不一致', [{ localFlags: 8 }]], ['local方式不一致', [{ localMethod: 0 }]],
  ['CRC不一致', [{ checksum: 1 }]], ['宣言サイズ不一致', [{ size: 1 }]],
  ['JSON上限超過', [{ data: Buffer.alloc(16385) }]],
  ['過少宣言ZIP bomb', [{ data: Buffer.alloc(1000000, 32), size: 16 }]],
  ['不正UTF-8', [{ data: Buffer.from([0xff, 0xfe]) }]], ['不正JSON', [{ data: Buffer.from('{') }]],
  ['重複JSONキー', [{ data: Buffer.from(JSON.stringify(record()).replace('"approved":true', '"approved":true,"approved":true')) }]],
  ['未知JSON項目', [{ data: Buffer.from(JSON.stringify({ ...record(), command: 'ignored?' })) }]],
  ['BOM付きJSON', [{ data: Buffer.from('\ufeff' + JSON.stringify(record())) }]],
]) {
  test(`危険なZIPを拒否: ${name}`, async () => {
    const b = zip(entries); await assert.rejects(readReleaseArchive(b, metadata(b)), /^Error: RELEASE_ARCHIVE_REJECTED$/);
  });
}
test('ZIP全体の改ざん・切断・上限超過を拒否', async () => {
  const b = zip(), m = metadata(b), tampered = Buffer.from(b); tampered[40] ^= 1;
  await assert.rejects(readReleaseArchive(tampered, m));
  const truncated = b.subarray(0, b.length - 1); await assert.rejects(readReleaseArchive(truncated, metadata(truncated)));
  const huge = Buffer.alloc(131073); await assert.rejects(readReleaseArchive(huge, metadata(huge)));
});
test('JSONサイズ上限ちょうど16KiBを受け入れる', async () => {
  const text = JSON.stringify(record()); const data = Buffer.from(text + ' '.repeat(16384 - Buffer.byteLength(text)));
  const b = zip([{ data }]); assert.deepEqual((await readReleaseArchive(b, metadata(b))).record, record());
});
