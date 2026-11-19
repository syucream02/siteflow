import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// OSの改行差を除き、スキーマとSQL履歴の同一性を確認する。秘密情報は読まない。
export function schemaHash(root = process.cwd()) {
  const directory=path.join(root,'db/design/migrations');
  const files=['db/design/integrated.prisma','db/design/migrations/migration_lock.toml',
    ...fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>'db/design/migrations/'+entry.name+'/migration.sql').sort()];
  const hash=createHash('sha256');
  for(const file of files)hash.update(file+'\0').update(fs.readFileSync(path.join(root,file),'utf8').replaceAll('\r\n','\n')).update('\0');
  return hash.digest('hex');
}
