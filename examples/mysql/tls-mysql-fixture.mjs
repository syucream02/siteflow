import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/integrated/client.ts';
import { readPublicApiSettings } from './public-api-settings.ts';
import { publicDatabaseOptions } from './public-database.ts';
import { isLocalDockerEndpoint } from './backup-check-settings.mjs';

// 既存MySQLを変更せず、TLS証明書・DB権限だけを試す使い捨てコンテナ。
export async function createTlsMysqlFixture({ networkName, volumeName, migrationImage } = {}) {
  if ((networkName || volumeName) && (!/^siteflow-docker-check-[a-f0-9]{12}$/.test(networkName ?? '') || networkName !== volumeName)) throw Error('INVALID_CHECK_RESOURCES');
  if (migrationImage && (!networkName || !/^siteflow:migration-check-[0-9]+$/.test(migrationImage))) throw Error('INVALID_MIGRATION_IMAGE');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const docker = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DockerDesktop/resources/bin/docker.exe') : 'docker';
  const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  const tag = randomBytes(6).toString('hex');
  const directory = path.join(root, 'work', `mysql-tls-check-${tag}`);
  const serverDirectory = path.join(directory, 'server');
  const cidFile = path.join(directory, 'container.id');
  const call = args => execFileSync(docker, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000 });
  let container, prisma, migrationReceipt, phase = 'prepare';
  const checks = [];
  async function close() {
    const failures = [];
    try { await prisma?.$disconnect(); } catch { failures.push('disconnect'); }
    if (!container && fs.existsSync(cidFile)) container = fs.readFileSync(cidFile, 'utf8').trim();
    if (container) {
      try {
        if (!/^[a-f0-9]{64}$/.test(container)) throw Error('INVALID_CONTAINER');
        call(['rm', '--force', '--volumes', container]);
      } catch { failures.push('container'); }
    }
    try {
      if (path.dirname(path.resolve(directory)) !== path.resolve(root, 'work') || !path.basename(directory).startsWith('mysql-tls-check-')) throw Error('INVALID_PATH');
      for (const name of ['server-key.pem','server.pem','ca.pem']) fs.rmSync(path.join(serverDirectory, name), { force: true });
      if (fs.existsSync(serverDirectory)) fs.rmdirSync(serverDirectory);
      for (const name of ['ca-key.pem','ca.pem','ca.srl','wrong-key.pem','wrong-ca.pem','server.csr','server.ext','container.id']) fs.rmSync(path.join(directory, name), { force: true });
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
    } catch { failures.push('certificate-files'); }
    if (failures.length) throw new Error('TLS_FIXTURE_CLEANUP_FAILED');
  }
  try {
    execFileSync('git', ['check-ignore','--quiet','--','work/'], { cwd: root, stdio: 'pipe', windowsHide: true });
    const endpoint = call(['context','inspect','--format','{{.Endpoints.docker.Host}}']).trim();
    if (!isLocalDockerEndpoint(endpoint, process.platform) || (process.env.DOCKER_HOST && !isLocalDockerEndpoint(process.env.DOCKER_HOST, process.platform))) throw Error('REMOTE_DOCKER_NOT_ALLOWED');
    fs.mkdirSync(serverDirectory, { recursive: true });
    const ssl = args => execFileSync(openssl, args, { cwd: directory, stdio: 'pipe', windowsHide: true, timeout: 30000 });
    ssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca-key.pem','-out','ca.pem','-days','1','-subj','/CN=SiteFlowLocalCheckCA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    ssl(['req','-newkey','rsa:2048','-nodes','-keyout','server/server-key.pem','-out','server.csr','-subj','/CN=mysql.siteflow.test']);
    fs.writeFileSync(path.join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:mysql.siteflow.test\n');
    ssl(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca-key.pem','-CAcreateserial','-out','server/server.pem','-days','1','-extfile','server.ext']);
    ssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','wrong-key.pem','-out','wrong-ca.pem','-days','1','-subj','/CN=WrongLocalCheckCA','-addext','basicConstraints=critical,CA:TRUE']);
    fs.copyFileSync(path.join(directory, 'ca.pem'), path.join(serverDirectory, 'ca.pem'));
    const rootPassword = randomBytes(24).toString('hex');
    phase = 'start-mysql';
    // CAの秘密鍵はマウントしない。サーバー鍵はコンテナ内でmysql所有・600へコピーする。
    const entry = 'set -eu; mkdir -p /tmp/siteflow-tls; cp /etc/siteflow-check/ca.pem /etc/siteflow-check/server.pem /etc/siteflow-check/server-key.pem /tmp/siteflow-tls/; chown mysql:mysql /tmp/siteflow-tls/*; chmod 600 /tmp/siteflow-tls/server-key.pem; exec /usr/local/bin/docker-entrypoint.sh mysqld --ssl-ca=/tmp/siteflow-tls/ca.pem --ssl-cert=/tmp/siteflow-tls/server.pem --ssl-key=/tmp/siteflow-tls/server-key.pem --require-secure-transport=ON --tls-version=TLSv1.2,TLSv1.3';
    let hostPort = '';
    const runMysql = () => {
      container = execFileSync(docker, ['run','--detach','--pull=never','--cidfile',cidFile,'--name',`siteflow-tls-check-${tag}`,'--label','siteflow.check=mysql-tls','--env','MYSQL_ROOT_PASSWORD','--publish',`127.0.0.1:${hostPort}:3306`,'--mount',`type=bind,source=${serverDirectory},target=/etc/siteflow-check,readonly`,...(networkName ? ['--network',networkName,'--network-alias','mysql.siteflow.test','--network-alias','wrong.mysql.siteflow.test','--mount',`type=volume,source=${volumeName},target=/var/lib/mysql`,'--memory','512m','--memory-swap','512m'] : []),'--entrypoint','sh','mysql:8.4.13','-c',entry + (networkName ? ' --innodb-buffer-pool-size=128M --max-connections=30 --performance-schema=OFF' : '')], {
      cwd: root, env: { ...process.env, MYSQL_ROOT_PASSWORD: rootPassword }, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000,
    }).trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw Error('INVALID_CONTAINER');
    };
    runMysql();
    const sql = input => execFileSync(docker, ['exec','-i',container,'sh','-c','MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=socket --user=root --batch --skip-column-names --default-character-set=utf8mb4'], { cwd: root, input, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 5000 }).trim();
    const waitMysql = async () => {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { if (sql('SELECT @@port;') === '3306') { ready = true; break; } } catch { /* 初期化中 */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw Error('MYSQL_NOT_READY');
    };
    await waitMysql();
    const binding = call(['port',container,'3306/tcp']).trim();
    if (!/^127\.0\.0\.1:[0-9]+$/.test(binding)) throw Error('NONLOCAL_BINDING');
    hostPort = binding.split(':')[1];
    const database = `siteflow_public_tls_${tag}`, user = `sf_tls_${tag}`, password = randomBytes(24).toString('hex');
    phase = 'schema';
    sql(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nCREATE USER '${user}'@'%' IDENTIFIED BY '${password}' REQUIRE SSL;\nGRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${user}'@'%';`);
    const migrations = path.join(root, 'db/design/migrations');
    for (const name of migrationImage ? [] : fs.readdirSync(migrations).sort()) {
      const migration = path.join(migrations, name, 'migration.sql');
      if (fs.existsSync(migration)) sql(`USE \`${database}\`;\n` + fs.readFileSync(migration, 'utf8'));
    }
    const env = { SITEFLOW_PUBLIC_ORIGIN: 'https://siteflow.test', SITEFLOW_AUTH_SECRET: randomBytes(32).toString('hex'),
      SITEFLOW_DB_HOST: '127.0.0.1', SITEFLOW_DB_PORT: binding.split(':')[1], SITEFLOW_DB_NAME: database, SITEFLOW_DB_USER: user, SITEFLOW_DB_PASSWORD: password,
      SITEFLOW_DB_TLS: 'required', SITEFLOW_DB_CA_FILE: path.join(directory, 'ca.pem') };
    if (migrationImage) {
      phase = 'public-migrate';
      const migrationUser = `sf_migrate_${tag}`, migrationPassword = randomBytes(24).toString('hex');
      sql(`CREATE USER '${migrationUser}'@'%' IDENTIFIED BY '${migrationPassword}' REQUIRE SSL; GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${migrationUser}'@'%';`);
      const migrationEnv = { ...env, SITEFLOW_DB_HOST: 'mysql.siteflow.test', SITEFLOW_DB_PORT: '3306', SITEFLOW_DB_CA_FILE: '/run/siteflow/ca.pem',
        SITEFLOW_MIGRATION_USER: migrationUser, SITEFLOW_MIGRATION_PASSWORD: migrationPassword, SITEFLOW_MIGRATION_APPROVED: 'yes',
        SITEFLOW_MIGRATION_DIGEST: call(['image','inspect',migrationImage,'--format','{{.Id}}']).trim() };
      const migrate = overrides => {
        const values = { ...migrationEnv, ...overrides };
        try {
          const output = execFileSync(docker, ['run','--rm','--pull=never','--memory','512m','--memory-swap','512m','--network',networkName,'--mount',`type=bind,source=${directory}/ca.pem,target=/run/siteflow/ca.pem,readonly`,'--mount',`type=bind,source=${directory}/wrong-ca.pem,target=/run/siteflow/wrong-ca.pem,readonly`,...Object.keys(values).flatMap(key=>['--env',key]),migrationImage], {
            cwd: root, env: { ...process.env, ...values }, stdio: 'pipe', encoding:'utf8', windowsHide: true, timeout: 150000,
          }); migrationReceipt = JSON.parse(output.trim()); return migrationReceipt.verified === true;
        } catch { return false; }
      };
      for (const invalid of [{ SITEFLOW_MIGRATION_APPROVED: '' }, { SITEFLOW_DB_CA_FILE: '/run/siteflow/wrong-ca.pem' }, { SITEFLOW_DB_HOST: 'wrong.mysql.siteflow.test' }]) assert.equal(migrate(invalid), false);
      assert.equal(sql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${database}';`), '0');
      checks.push('承認なし・誤CA・不正な接続先ではmigration前に拒否し空DBを維持');
      assert.equal(migrate({}), true);
      const before = sql(`USE \`${database}\`; SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name;`);
      assert.equal(sql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${database}';`), '16');
      assert.equal(migrate({}), true);
      assert.equal(sql(`USE \`${database}\`; SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name;`), before);
      assert.equal(sql(`USE \`${database}\`; SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`), '2');
      checks.push('専用DockerイメージとTLSで2履歴・16テーブルを作成し、2回目は適用履歴不変');
      sql(`USE \`${database}\`; CREATE TABLE _siteflow_drift_probe (id INT PRIMARY KEY);`);
      assert.equal(migrate({}), false);
      assert.equal(sql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${database}';`), '17');
      sql(`USE \`${database}\`; DROP TABLE _siteflow_drift_probe;`);
      assert.equal(migrate({}), true);
      checks.push('DBの予期しない構造差分は証明を発行せず拒否し、自動削除で修復しない');
    }
    const options = publicDatabaseOptions(readPublicApiSettings(env));
    const create = options => new PrismaClient({ adapter: new PrismaMariaDb(options) });
    prisma = create(options); phase = 'connect-tls';
    const [cipher] = await prisma.$queryRawUnsafe("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    const [version] = await prisma.$queryRawUnsafe("SHOW SESSION STATUS LIKE 'Ssl_version'");
    phase = 'verify-cipher'; assert.ok(cipher.Value); assert.ok(['TLSv1.2','TLSv1.3'].includes(version.Value));
    checks.push('Prisma経由の実MySQL通信でTLSバージョンと暗号方式を確認');
    const wrongHost = publicDatabaseOptions(readPublicApiSettings({ ...env, SITEFLOW_DB_HOST: 'localhost' }));
    for (const [label, invalidOptions] of [['reject-ca',{ ...options, ssl: { ...options.ssl, ca: fs.readFileSync(path.join(directory, 'wrong-ca.pem'), 'utf8') } }], ['reject-host',wrongHost], ['reject-plain',{ ...options, ssl: false }]]) {
      phase = label;
      const invalid = create({ ...invalidOptions, connectTimeout: 1500, acquireTimeout: 2000 });
      try {
        await assert.rejects(invalid.$queryRaw`SELECT 1`, error => label !== 'reject-host' || /certificate|altname|identity/i.test(JSON.stringify(error)));
      } finally { await invalid.$disconnect(); }
    }
    checks.push('異なるCA・証明書の接続先名不一致・平文接続を拒否');
    phase = 'runtime-privileges'; await assert.rejects(prisma.$executeRawUnsafe('CREATE TABLE runtime_must_not_create (id INT)'));
    checks.push('アプリ用DBユーザーはCREATE権限を持たない');
    const recreate = async () => {
      if (!volumeName) throw Error('NAMED_CHECK_VOLUME_REQUIRED');
      await prisma.$disconnect();
      call(['rm','--force','--volumes',container]); container = undefined;
      fs.rmSync(cidFile);
      runMysql();
      await waitMysql();
      const current = call(['port',container,'3306/tcp']).trim();
      if (!/^127\.0\.0\.1:[0-9]+$/.test(current)) throw Error('NONLOCAL_BINDING');
      env.SITEFLOW_DB_PORT = current.split(':')[1];
      // 同じホスト側ポートへ戻すので、検証用Prismaも再接続できる。
    };
    return { env, prisma, migrationReceipt, close, checks, recreate, mysqlId: () => container, tlsVersion: version.Value, wrongCaFile: path.join(directory, 'wrong-ca.pem') };
  } catch (error) {
    await close();
    const code = /^[A-Za-z0-9_]+$/.test(error?.code ?? '') ? error.code : error?.name ?? 'FAILED';
    const serialized = JSON.stringify(error);
    const flags = ['certificate','localhost','ECONNREFUSED','pool timeout'].filter(word => serialized.includes(word)).map(word => word.replace(' ', '_'));
    throw new Error(`TLS_FIXTURE_FAILED_${phase}_${code}_${flags.join('_')}`);
  }
}
