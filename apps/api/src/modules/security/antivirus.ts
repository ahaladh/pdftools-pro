import { createReadStream } from 'node:fs';
import net from 'node:net';
import type { Request } from 'express';
import type { Logger } from 'pino';
import { HttpError } from '../../utils/errors.js';
import { safeFilename } from '../../utils/security.js';

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  /** The scanner could not give an answer (down, timed out, refused the size, garbled reply). Never a verdict about the file. */
  | { status: 'error'; reason: 'size_limit' | 'timeout' | 'unavailable' | 'protocol'; detail: string };

export interface Scanner {
  scan(path: string): Promise<ScanResult>;
  ping(): Promise<{ ok: boolean; version?: string; error?: string }>;
}

export interface ClamdOptions {
  host: string; port: number; /** Unix socket path; wins over host/port. */ socketPath?: string;
  /** Whole-scan deadline. */ timeoutMs: number; chunkBytes?: number;
}

/** Text from the daemon goes into logs and audit entries: keep it short and free of control characters. */
const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, '').slice(0, 100);

/** Parse clamd's reply to INSTREAM: `stream: OK`, `stream: <Signature> FOUND`, or `<message> ERROR`. */
export function parseReply(raw: string): ScanResult {
  const text = raw.replace(/[\0\n]+$/g, '').trim();
  if (/^stream: OK$/.test(text)) return { status: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { status: 'infected', signature: clean(found[1]!) };
  if (/size limit/i.test(text)) return { status: 'error', reason: 'size_limit', detail: clean(text) };
  return { status: 'error', reason: 'protocol', detail: clean(text) || 'empty reply' };
}

/**
 * A client for ClamAV's daemon (clamd) over TCP or a Unix socket, using its INSTREAM command: the file is streamed to the
 * daemon in length-prefixed chunks, so nothing is read into memory and the daemon needs no access to our filesystem.
 * Note clamd refuses streams longer than its StreamMaxLength (25 MB by default): raise it to match the largest upload you allow.
 */
export class ClamdScanner implements Scanner {
  constructor(private o: ClamdOptions) {}

  private connect(): net.Socket {
    return this.o.socketPath ? net.createConnection({ path: this.o.socketPath }) : net.createConnection({ host: this.o.host, port: this.o.port });
  }

  scan(path: string): Promise<ScanResult> {
    return new Promise((resolve) => {
      const sock = this.connect();
      const file = createReadStream(path, { highWaterMark: this.o.chunkBytes ?? 64 * 1024 });
      let reply = '', settled = false;
      const finish = (r: ScanResult) => { if (settled) return; settled = true; clearTimeout(timer); file.destroy(); sock.destroy(); resolve(r); };
      const timer = setTimeout(() => finish({ status: 'error', reason: 'timeout', detail: `no answer within ${this.o.timeoutMs} ms` }), this.o.timeoutMs);
      sock.on('error', (e) => finish({ status: 'error', reason: 'unavailable', detail: clean((e as NodeJS.ErrnoException).code ?? e.message) }));
      // The daemon may answer before we finish sending (a size-limit error): take the answer as soon as it is complete.
      sock.on('data', (d) => { reply += d.toString('latin1'); if (reply.includes('\0') || reply.includes('\n')) finish(parseReply(reply)); });
      sock.on('close', () => finish(reply ? parseReply(reply) : { status: 'error', reason: 'unavailable', detail: 'connection closed before an answer' }));
      file.on('error', (e) => finish({ status: 'error', reason: 'unavailable', detail: clean(`could not read the file: ${e.message}`) }));
      sock.on('connect', () => {
        void (async () => {
          try {
            sock.write('zINSTREAM\0');
            for await (const chunk of file) {
              if (settled) return;
              const head = Buffer.alloc(4); head.writeUInt32BE((chunk as Buffer).length);
              // waiting for 'drain' (or the socket dying) is the backpressure: a slow daemon slows the read, memory stays at one chunk
              if (!sock.write(Buffer.concat([head, chunk as Buffer]))) await new Promise<void>((r) => { sock.once('drain', () => r()); sock.once('close', () => r()); });
            }
            if (!settled) sock.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
          } catch (e) { finish({ status: 'error', reason: 'unavailable', detail: clean((e as Error).message) }); }
        })();
      });
    });
  }

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    const ask = (cmd: string) => new Promise<string>((resolve, reject) => {
      const sock = this.connect(); let out = '';
      const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, Math.min(this.o.timeoutMs, 5000));
      sock.on('error', (e) => { clearTimeout(t); reject(e); });
      sock.on('data', (d) => { out += d.toString('latin1'); });
      sock.on('close', () => { clearTimeout(t); resolve(out.replace(/[\0\n]+$/g, '')); });
      sock.on('connect', () => sock.write(`z${cmd}\0`));
    });
    try {
      if ((await ask('PING')) !== 'PONG') return { ok: false, error: 'unexpected reply to PING' };
      return { ok: true, version: clean(await ask('VERSION')) };
    } catch (e) { return { ok: false, error: clean((e as NodeJS.ErrnoException).code ?? (e as Error).message) }; }
  }
}

export interface UploadScannerDeps {
  log: Pick<Logger, 'warn' | 'error'>;
  /** Count a scan result (clean, infected, error, error_allowed). */
  count?: (result: string) => void;
  /** Record that a file was blocked. */
  blocked?: (req: Request, signature: string) => Promise<void>;
}

/**
 * Policy on top of a Scanner: what happens to an upload. `off`: nothing. `enforce`: every file is scanned before a job exists; an
 * infected file refuses the whole request; a scanner that cannot answer refuses it too (`failOpen: false`, the default) or lets it
 * through with a warning (`failOpen: true`, for operators who prefer availability to certainty).
 */
export class UploadScanner {
  constructor(private cfg: { mode: 'off' | 'enforce'; failOpen: boolean }, private scanner: Scanner | null, private deps: UploadScannerDeps, private concurrency = 3) {}

  get enabled() { return this.cfg.mode === 'enforce' && !!this.scanner; }

  async check(req: Request, files: { path: string; name: string }[]): Promise<void> {
    if (!this.enabled) return;
    const results = new Array<ScanResult>(files.length);
    let next = 0;
    // A few at a time: a batch of many files must not open that many connections to the daemon.
    await Promise.all(Array.from({ length: Math.min(this.concurrency, files.length) }, async () => {
      while (next < files.length) { const i = next++; results[i] = await this.scanner!.scan(files[i]!.path); }
    }));
    for (const [i, r] of results.entries()) {
      const name = safeFilename(files[i]!.name);
      if (r.status === 'infected') {
        this.deps.count?.('infected');
        this.deps.log.warn({ signature: r.signature, owner: req.owner }, 'upload blocked by the virus scanner');
        await this.deps.blocked?.(req, r.signature).catch((e) => this.deps.log.error({ err: e }, 'could not record a blocked upload'));
        throw new HttpError(422, 'malware_detected', `"${name}" was blocked: our virus scan found something harmful in it. Nothing was processed.`);
      }
    }
    for (const [i, r] of results.entries()) {
      if (r.status === 'clean') { this.deps.count?.('clean'); continue; }
      if (r.status !== 'error') continue;
      if (this.cfg.failOpen) { this.deps.count?.('error_allowed'); this.deps.log.warn({ reason: r.reason, detail: r.detail }, 'virus scanner could not answer: upload allowed (AV_FAIL=open)'); continue; }
      this.deps.count?.('error');
      this.deps.log.error({ reason: r.reason, detail: r.detail }, 'virus scanner could not answer: upload refused (AV_FAIL=closed)');
      if (r.reason === 'size_limit') throw new HttpError(413, 'scan_too_large', `"${safeFilename(files[i]!.name)}" is too large for the virus scanner, so it was not accepted.`);
      throw new HttpError(503, 'scanner_unavailable', 'File scanning is temporarily unavailable, so uploads are paused. Please try again shortly.');
    }
  }
}
