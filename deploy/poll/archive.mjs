import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { isDigest, need, validateReleaseRecord } from './contract.mjs';
import { decodeStrictJson } from './transport.mjs';

// ZIP構造はyauzlに委ねる。独自パーサー・ディスク展開・一般的なunzip実行なし。
const NAME = Buffer.from('approved-release.json');
export async function readReleaseArchive(bytes, metadata) {
  let zip;
  try {
    need(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 131072, 'ZIP_SIZE_REJECTED');
    const buffer = Buffer.from(bytes); // 呼び出し元による検査途中の変更を避ける。
    need(metadata && metadata.size_in_bytes === buffer.length && isDigest(metadata.digest), 'ZIP_METADATA_MISMATCH');
    const digest = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
    need(digest === metadata.digest, 'ZIP_DIGEST_MISMATCH');
    zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
    need(zip.entryCount === 1, 'ZIP_ENTRY_COUNT_REJECTED');
    let count = 0, jsonBytes;
    for await (const entry of zip.eachEntry()) {
      count++; need(count === 1 && entry.fileName === NAME.toString('ascii') && entry.fileNameRaw.equals(NAME), 'ZIP_NAME_REJECTED');
      const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
      need((kind === 0 || kind === 0x8000) && !(entry.externalFileAttributes & 0x10), 'ZIP_NON_REGULAR_FILE');
      need(!entry.isEncrypted() && !(entry.generalPurposeBitFlag & ~0x80e) &&
        [0, 8].includes(entry.compressionMethod) && [10, 20].includes(entry.versionNeededToExtract) &&
        (entry.compressionMethod === 8 || !(entry.generalPurposeBitFlag & 6)) &&
        (!(entry.generalPurposeBitFlag & 8) || entry.versionNeededToExtract === 20), 'ZIP_FORMAT_REJECTED');
      need(entry.uncompressedSize > 0 && entry.uncompressedSize <= 16384 && entry.compressedSize <= 131072, 'ZIP_EXPANDED_SIZE_REJECTED');
      const local = await zip.readLocalFileHeaderPromise(entry, { minimal: false });
      need(local.fileName.equals(NAME) && local.generalPurposeBitFlag === entry.generalPurposeBitFlag &&
        local.compressionMethod === entry.compressionMethod && local.versionNeededToExtract === entry.versionNeededToExtract,
      'LOCAL_HEADER_MISMATCH');
      for (const key of ['crc32', 'compressedSize', 'uncompressedSize']) {
        // bit3は値の後置を示す。0の未確定値を許し、中央ディレクトリを正とする。
        need(local[key] === entry[key] || ((entry.generalPurposeBitFlag & 8) && local[key] === 0), 'LOCAL_HEADER_SIZE_OR_CRC_MISMATCH');
      }
      const stream = await zip.openReadStreamPromise(entry), chunks = [];
      let size = 0, checksum = 0;
      try {
        for await (const chunk of stream) {
          size += chunk.length;
          need(size <= 16384 && size <= entry.uncompressedSize, 'ZIP_BOMB_REJECTED');
          checksum = crc32(chunk, checksum); chunks.push(chunk);
        }
      } finally { stream.destroy(); }
      need(size === entry.uncompressedSize && checksum === entry.crc32, 'ZIP_CRC_OR_SIZE_MISMATCH');
      jsonBytes = Buffer.concat(chunks);
    }
    need(count === 1 && jsonBytes, 'ZIP_ENTRY_MISSING');
    const record = validateReleaseRecord(decodeStrictJson(jsonBytes));
    return { record, jsonBytes, zipDigest: digest, executionAllowed: false };
  } catch { throw new Error('RELEASE_ARCHIVE_REJECTED'); }
  finally { if (zip) zip.close(); }
}
