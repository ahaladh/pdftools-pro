/**
 * A stand-in for ClamAV's daemon that implements the parts of its wire protocol the client uses (PING, VERSION, INSTREAM with
 * length-prefixed chunks), written from clamd's documentation. It "detects" the EICAR test string, the industry-standard harmless
 * test file every scanner flags. Test-only; it is not a scanner. It records what it received so tests can check the framing
 * and that the bytes arrive intact.
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import { unlinkSync } from 'node:fs';

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export type Behaviour = 'normal' | 'hang' | 'close-early' | 'garbage' | 'weird-signature';
export interface Seen { commands: string[]; streams: { bytes: number; sha256: string; chunks: number; terminated: boolean }[]; maxOpen: number }

export class FakeClamd {
  behaviour: Behaviour = 'normal';
  /** clamd's StreamMaxLength: a stream longer than this is answered with an error (default 25 MB there). */
  streamMax = Infinity;
  /** Hold every INSTREAM reply for this long, to make concurrency observable. */
  replyDelayMs = 0;
  seen: Seen = { commands: [], streams: [], maxOpen: 0 };
  private open = 0;
  private server: net.Server;
  port = 0;
  constructor(private socketPath?: string) {
    this.server = net.createServer((sock) => {
      this.open++; this.seen.maxOpen = Math.max(this.seen.maxOpen, this.open);
      sock.on('close', () => { this.open--; });
      sock.on('error', () => undefined);
      let buf = Buffer.alloc(0), mode: 'command' | 'stream' | 'dead' = 'command', total = 0, chunks = 0, hash = createHash('sha256'), contents = Buffer.alloc(0), over = false;
      const say = (s: string) => { setTimeout(() => { if (!sock.destroyed) sock.end(`${s}\0`); }, this.replyDelayMs); };
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (mode === 'dead') return; // accepted, and now deliberately silent
          if (mode === 'command') {
            const end = buf.indexOf(0); if (end < 0) return;
            const cmd = buf.subarray(0, end).toString(); buf = buf.subarray(end + 1);
            this.seen.commands.push(cmd);
            if (cmd === 'zPING') return void sock.end('PONG\0');
            if (cmd === 'zVERSION') return void sock.end('ClamAV 1.4.0-fake/27000/Mon Jan  1 00:00:00 2026\0');
            if (cmd !== 'zINSTREAM') return void sock.end('UNKNOWN COMMAND\0');
            if (this.behaviour === 'hang') { mode = 'dead'; return; } // accept and never answer
            mode = 'stream';
          } else {
            if (buf.length < 4) return;
            const len = buf.readUInt32BE(0);
            if (len === 0) {
              buf = buf.subarray(4);
              if (over) return; // already answered with the size error
              this.seen.streams.push({ bytes: total, sha256: hash.digest('hex'), chunks, terminated: true });
              if (this.behaviour === 'garbage') return say('what is this');
              if (this.behaviour === 'weird-signature') return say('stream: Evil\x1b[31m.Name\x07 FOUND');
              return say(contents.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK');
            }
            if (buf.length < 4 + len) return;
            const data = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
            if (over) continue; // the stream was refused: ignore what is still arriving
            total += len; chunks++; hash.update(data); contents = Buffer.concat([contents, data]);
            if (this.behaviour === 'close-early' && chunks >= 2) return void sock.destroy();
            if (total > this.streamMax && !over) { over = true; this.seen.streams.push({ bytes: total, sha256: hash.digest('hex'), chunks, terminated: false }); return say('INSTREAM size limit exceeded. ERROR'); }
          }
        }
      });
    });
  }
  async start(): Promise<this> {
    await new Promise<void>((r) => (this.socketPath ? this.server.listen(this.socketPath, r) : this.server.listen(0, '127.0.0.1', r)));
    if (!this.socketPath) this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); if (this.socketPath) try { unlinkSync(this.socketPath); } catch { /* gone */ } }
  reset() { this.seen = { commands: [], streams: [], maxOpen: 0 }; this.behaviour = 'normal'; this.streamMax = Infinity; this.replyDelayMs = 0; }
}
