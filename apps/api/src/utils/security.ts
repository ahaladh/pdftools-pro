import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

export const newId = (bytes = 16) => randomBytes(bytes).toString('hex');

/** Make a user-supplied filename safe for storage display and headers. */
export function safeFilename(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? fallback; // path traversal
  const cleaned = base.normalize('NFKC').replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || fallback;
}

export function signDownload(secret: string, fileId: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac('sha256', secret).update(`${fileId}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyDownload(secret: string, fileId: string, token: string | undefined): boolean {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = createHmac('sha256', secret).update(`${fileId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type DetectedKind = 'pdf' | 'jpg' | 'png' | 'office';

/** Detect type from magic bytes — never trust client MIME or extension. */
export function detectKind(head: Buffer): DetectedKind | null {
  if (head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OOXML_DIR: Record<string, string> = { '.docx': 'word/', '.xlsx': 'xl/', '.pptx': 'ppt/' };

/**
 * Office files have no distinctive magic bytes (OOXML is a ZIP), so combine the container signature
 * with the extension and, for OOXML, the package structure. Only entry names are read; nothing is inflated.
 */
export async function detectOffice(path: string, name: string): Promise<boolean> {
  const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? '').toLowerCase();
  const bytes = await readFile(path);
  if (['.doc', '.xls', '.ppt'].includes(ext)) return bytes.subarray(0, 8).equals(OLE_MAGIC);
  const dir = OOXML_DIR[ext];
  if (!dir || !bytes.subarray(0, 4).equals(ZIP_MAGIC)) return false;
  const names: string[] = [];
  try {
    unzipSync(new Uint8Array(bytes), { filter: (f) => { if (names.length < 20000) names.push(f.name); return false; } });
  } catch { return false; }
  return names.includes('[Content_Types].xml') && names.some((n) => n.startsWith(dir));
}
