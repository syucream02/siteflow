import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ローカルイメージ専用。秘密値そのものやファイル本文は出力しない。
const root = fileURLToPath(new URL('../', import.meta.url));
const docker = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DockerDesktop/resources/bin/docker.exe') : 'docker';
const call = args => execFileSync(docker, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 120000 });
const { isLocalDockerEndpoint } = await import('../examples/mysql/backup-check-settings.mjs');
const endpoint = call(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
if (!isLocalDockerEndpoint(endpoint, process.platform) || (process.env.DOCKER_HOST && !isLocalDockerEndpoint(process.env.DOCKER_HOST, process.platform))) throw Error('LOCAL_DOCKER_REQUIRED');
const tag = randomBytes(6).toString('hex');
const output = path.join(root, 'work', 'docker-image-audit-' + tag);
fs.mkdirSync(output, { recursive: true });
const marker = 'SITEFLOW_AUDIT_' + randomBytes(24).toString('hex');
const probes = ['.env.docker-audit-' + tag, 'public/.env.docker-audit-' + tag, 'lib/docker-audit-' + tag + '.key'];
const needles = [Buffer.from(marker)];
// 既存のローカル環境ファイルから秘密値だけをメモリ上で照合する。
for (const name of ['.env.mysql.local', '.env.schema-check.local']) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]*(?:PASSWORD|SECRET)[A-Z_]*)=(.*)$/);
    if (match) { const value = match[2].replace(/^['"]|['"]$/g, ''); if (value.length >= 16) needles.push(Buffer.from(value)); }
  }
}
function entries(buffer) {
  const result = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/, '');
    const name = (string(345, 155) ? string(345, 155) + '/' : '') + string(0, 100);
    const size = parseInt(string(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length) throw Error('INVALID_ARCHIVE');
    result.push({ name, type: string(156, 1), data: buffer.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}
let passed = false;
try {
  for (const file of probes) fs.writeFileSync(path.join(root, file), marker, { flag: 'wx' });
  const context = path.join(output, 'context');
  call(['build', '--target', 'source-audit', '--output', 'type=local,dest=' + context, '.']);
  let contextFiles = 0;
  const visit = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else {
        contextFiles++;
        const relative = path.relative(path.join(context, 'context'), file).replaceAll('\\', '/');
        const migrationSql = /^db\/design\/migrations\/[a-z0-9_]+\/migration.sql$/.test(relative);
        if (/^\.env(?:\.|$)/.test(item.name) || /\.(pem|key|p12|pfx)$/.test(item.name)
          || item.name.endsWith('.sql') && !migrationSql || needles.some(n => fs.readFileSync(file).includes(n))) throw Error('CONTEXT_SECRET_FOUND');
      }
    }
  };
  visit(context);
  const archive = path.join(output, 'image.tar');
  call(['image', 'save', '--output', archive, process.env.SITEFLOW_DOCKER_IMAGE ?? 'siteflow:docker-check-20261116']);
  const outer = entries(fs.readFileSync(archive));
  const manifest = JSON.parse(outer.find(e => e.name === 'manifest.json').data.toString());
  let layers = 0, files = 0;
  for (const name of manifest[0].Layers) {
    layers++;
    let blob = outer.find(e => e.name === name).data;
    if (blob[0] === 0x1f && blob[1] === 0x8b) blob = zlib.gunzipSync(blob);
    for (const entry of entries(blob)) {
      files++;
      if (entry.name.includes('docker-audit-' + tag) || needles.some(n => entry.data.includes(n))) throw Error('IMAGE_SECRET_FOUND');
      if (/^app\/(?:\.env(?:\.|$)|(?:work|\.aws|\.git)\/)/.test(entry.name)) throw Error('IMAGE_LOCAL_FILE_FOUND');
    }
  }
  fs.writeFileSync(path.join(root, 'work', 'docker-image-audit.json'), JSON.stringify({ passed: true, contextFiles, imageLayers: layers, imageEntries: files, checks: ['root/nested env and key canaries excluded from actual Docker context', 'all final-image layers scanned for canary and available local credentials', 'local env/work/aws/git paths absent from app layers'], scope: 'local files and explicit probes; not a guarantee against secrets embedded in arbitrary source code' }, null, 2));
  console.log(`PASS: context ${contextFiles} files; final image ${layers} layers scanned; no local credential/canary match`);
  passed = true;
} finally {
  for (const file of probes) { const target = path.join(root, file); if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === marker) fs.rmSync(target); }
  // この実行が作ったwork直下のディレクトリのみ削除する。
  if (path.dirname(path.resolve(output)) !== path.resolve(root, 'work') || !path.basename(output).startsWith('docker-image-audit-')) throw Error('INVALID_CLEANUP_PATH');
  fs.rmSync(output, { recursive: true, force: true });
  if (!passed) process.exitCode = 1;
}
