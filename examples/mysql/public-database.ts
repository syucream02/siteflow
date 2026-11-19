import { readFileSync, statSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import type { PrismaMariaDb } from '@prisma/adapter-mariadb';
import type { PublicApiSettings } from './public-api-settings.ts';

type DatabaseOptions = Exclude<ConstructorParameters<typeof PrismaMariaDb>[0], string>;

export function publicDatabaseOptions(settings: PublicApiSettings): DatabaseOptions {
  const db = settings.database;
  let ca: string | undefined;
  if (db.caFile) {
    try {
      const info = statSync(db.caFile);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('INVALID_CA');
      ca = readFileSync(db.caFile, 'utf8');
      const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (!certificates?.length || /PRIVATE KEY/.test(ca) || certificates.some(cert => !new X509Certificate(cert).ca)) throw new Error('INVALID_CA');
    } catch { throw new Error('DBのCA証明書を読み込めません。設定を確認してください。'); }
  }
  // ソケットの内部名ではなく、管理者が設定した実際のDB接続先を検証する。
  const ssl: ConnectionOptions = { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}),
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(db.host, certificate) };
  return { host: db.host, port: db.port, database: db.name, user: db.user, password: db.password, ssl,
    connectionLimit: 2, connectTimeout: 5000, acquireTimeout: 5000 };
}
