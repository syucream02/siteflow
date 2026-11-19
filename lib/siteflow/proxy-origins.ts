// URLの接続先判定用。公開用はPC内/プライベートIPv4を許可しない。
function publicIPv4(host: string): boolean {
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host)) return false;
  const [a, b, c, d] = host.split('.').map(Number);
  return [a, b, c, d].every(part => part <= 255) && a > 0 && a < 224 && a !== 10 && a !== 127
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
}

export function publicProxyOrigin(value: string | undefined): URL | null {
  try {
    const origin = new URL(value ?? '');
    if (origin.protocol !== 'https:' || origin.origin !== value || origin.username || origin.password
      || !origin.hostname.includes('.') || origin.hostname.length > 253
      || !origin.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      || /^[0-9.]+$/.test(origin.hostname) && !publicIPv4(origin.hostname)
      || /(?:^|\.)(?:localhost|local|internal)$/i.test(origin.hostname)) return null;
    return origin;
  } catch { return null; }
}

export function loopbackApiOrigin(value: string | undefined): URL | null {
  try {
    const origin = new URL(value ?? '');
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
    return origin;
  } catch { return null; }
}
