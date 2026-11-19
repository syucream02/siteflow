// Content-Lengthだけを信用せず、読み込み中にバイト数を制限する。
export async function readJsonBody(request: Request, maxBytes: number): Promise<{ value?: unknown; tooLarge?: boolean; invalid?: boolean }> {
  const reader = request.body?.getReader();
  if (!reader) return { invalid: true };
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => {}); return { tooLarge: true }; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch { return { invalid: true }; }
  finally { reader.releaseLock(); }
}
