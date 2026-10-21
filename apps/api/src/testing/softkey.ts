/**
 * A software FIDO2/WebAuthn authenticator written from the specifications (CBOR, COSE, authenticator data, ES256), used as
 * an independent oracle in tests: it shares no code with the verifier under test. Test-only; never part of the build.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

// ---- minimal CBOR encoder (definite lengths; unsigned/negative ints, byte/text strings, maps)
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  throw new Error('too large for this encoder');
}
export type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export interface CreateOpts { origin?: string; rpId?: string; challenge?: string; type?: string; counter?: number; flags?: number }
export interface GetOpts { origin?: string; rpId?: string; challenge?: string; type?: string; counter?: number; flags?: number; signWith?: KeyObject; credentialId?: string }

export class SoftKey {
  readonly credentialId = randomBytes(32);
  private priv: KeyObject;
  private pubJwk: { x: string; y: string };
  counter = 0;
  constructor(public readonly transports: string[] = ['usb']) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey;
    this.pubJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }
  get id() { return b64u(this.credentialId); }
  get privateKey() { return this.priv; }

  private cose(): Buffer {
    return cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.pubJwk.x, 'base64url')], [-3, Buffer.from(this.pubJwk.y, 'base64url')]]));
  }
  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  private counterBytes(n: number) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

  /** navigator.credentials.create() for `options` (the JSON the server sent), as the browser would return it. */
  create(options: { challenge: string; rp: { id?: string } }, o: CreateOpts = {}) {
    const rpId = o.rpId ?? options.rp.id ?? 'localhost';
    this.counter = o.counter ?? 0;
    const cred = Buffer.concat([Buffer.alloc(16), Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 255]), this.credentialId, this.cose()]);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([o.flags ?? 0x41]), this.counterBytes(this.counter), cred]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id, rawId: this.id, type: 'public-key' as const, authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: b64u(this.clientData(o.type ?? 'webauthn.create', o.challenge ?? options.challenge, o.origin ?? 'http://localhost:5173')), attestationObject: b64u(attestationObject), transports: this.transports },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get(): signs authData || sha256(clientDataJSON). The counter increases by one unless `o.counter` says otherwise. */
  get(options: { challenge: string; rpId?: string }, o: GetOpts = {}) {
    const rpId = o.rpId ?? options.rpId ?? 'localhost';
    this.counter = o.counter ?? this.counter + 1;
    const clientDataJSON = this.clientData(o.type ?? 'webauthn.get', o.challenge ?? options.challenge, o.origin ?? 'http://localhost:5173');
    const authData = Buffer.concat([sha256(rpId), Buffer.from([o.flags ?? 0x01]), this.counterBytes(this.counter)]);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), { key: o.signWith ?? this.priv, dsaEncoding: 'der' });
    const id = o.credentialId ?? this.id;
    return {
      id, rawId: id, type: 'public-key' as const, authenticatorAttachment: 'cross-platform',
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) },
      clientExtensionResults: {},
    };
  }
}
