const cookieName = /^(?:__Secure-|__Host-)better-auth\.[A-Za-z0-9_.-]+$/;

// このアプリのBetter Authだけを中継する。別用途のCookieを内部APIへ送らない。
export function publicRequestCookies(raw: string | null): string | null {
  if (!raw) return null;
  const selected: string[] = []; const seen = new Set<string>();
  for (const part of raw.split(';')) {
    const pair = part.trim(); const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    if (!cookieName.test(name)) continue;
    if (seen.has(name) || /[^\x21-\x7e]/.test(pair)) throw new Error('INVALID_COOKIE');
    seen.add(name); selected.push(pair);
  }
  return selected.length ? selected.join('; ') : null;
}

export function publicResponseCookie(cookie: string): string {
  const [pair, ...parts] = cookie.split(';').map(value => value.trim());
  const separator = pair.indexOf('='); const name = pair.slice(0, separator);
  if (separator < 1 || !cookieName.test(name) || /[^\x21-\x7e]/.test(pair)) throw new Error('INVALID_COOKIE');
  const attributes = new Map<string, string | null>();
  for (const part of parts) {
    const split = part.indexOf('=');
    const key = (split < 0 ? part : part.slice(0, split)).toLowerCase();
    const value = split < 0 ? null : part.slice(split + 1);
    if (!['path','secure','httponly','samesite','max-age','expires'].includes(key) || attributes.has(key)) throw new Error('INVALID_COOKIE');
    attributes.set(key, value);
  }
  if (!attributes.has('secure') || attributes.get('secure') !== null
    || !attributes.has('httponly') || attributes.get('httponly') !== null
    || attributes.get('samesite')?.toLowerCase() !== 'lax') throw new Error('INVALID_COOKIE');
  const path = attributes.get('path');
  if (path !== '/' && path !== '/api/siteflow') throw new Error('INVALID_COOKIE');
  if (name.startsWith('__Host-') && path !== '/') throw new Error('INVALID_COOKIE');
  if (attributes.has('max-age') && !/^-?[0-9]+$/.test(attributes.get('max-age') ?? '')) throw new Error('INVALID_COOKIE');
  if (attributes.has('expires') && !Number.isFinite(Date.parse(attributes.get('expires') ?? ''))) throw new Error('INVALID_COOKIE');
  // __Host-はルートのまま。__Secure-の発行/削除は同じ中継Pathへ揃える。
  return [pair, ...parts.map(part => /^path=/i.test(part) && !name.startsWith('__Host-') ? 'Path=/api/siteflow' : part)].join('; ');
}
