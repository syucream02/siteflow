import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// 値はプロセス内でだけ使う。DockerのEnvへ展開せず、元の例外も公開しない。
export function readSecretSetting(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const file = env[`${key}_FILE`];
  if (file === undefined) return env[key];
  let fd: number | undefined;
  try {
    if (env[key] !== undefined || !isAbsolute(file) || /[\0\r\n]/.test(file)) throw Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw Error();
    const value = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (!value || /[\0\r\n]/.test(value)) throw Error();
    return value;
  } catch { throw new Error('SECRET_FILE_UNAVAILABLE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
