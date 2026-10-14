/**
 * Minimal PDF content-stream tokenizer. Streams are handled as latin1 strings (one char per byte) so that
 * byte offsets are string offsets and untouched operators can be copied through verbatim.
 */
export type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }          // raw bytes as latin1 chars
  | { t: 'name'; v: string }
  | { t: 'arr'; v: Tok[] }
  | { t: 'other'; v: string };

export interface Op { op: string; args: Tok[]; start: number; end: number }

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const isWs = (c: number) => WS.has(c);
const isReg = (c: number) => !WS.has(c) && !DELIM.has(c);
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function tokenize(s: string): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let args: Tok[] = [];
  let opStart = -1;
  const n = s.length;

  const skip = () => {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isWs(c)) i++;
      else if (c === 0x25) { while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; }
      else break;
    }
  };
  const literal = (): string => {
    let depth = 1, out = '';
    i++; // (
    while (i < n && depth > 0) {
      const ch = s[i]!;
      if (ch === '\\') {
        const nx = s[i + 1] ?? '';
        i += 2;
        if (nx === 'n') out += '\n'; else if (nx === 'r') out += '\r'; else if (nx === 't') out += '\t';
        else if (nx === 'b') out += '\b'; else if (nx === 'f') out += '\f';
        else if (nx >= '0' && nx <= '7') {
          let oct = nx;
          while (oct.length < 3 && s[i]! >= '0' && s[i]! <= '7') oct += s[i++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (nx === '\r') { if (s[i] === '\n') i++; }
        else if (nx === '\n') { /* line continuation */ }
        else out += nx;
      } else if (ch === '(') { depth++; out += ch; i++; }
      else if (ch === ')') { depth--; if (depth > 0) out += ch; i++; }
      else { out += ch; i++; }
    }
    return out;
  };
  const hex = (): string => {
    i++; // <
    let h = '';
    while (i < n && s[i] !== '>') { if (!isWs(s.charCodeAt(i))) h += s[i]; i++; }
    i++; // >
    if (h.length % 2) h += '0';
    let out = '';
    for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16) || 0);
    return out;
  };
  const value = (): Tok => {
    const c = s.charCodeAt(i);
    if (c === 0x28) return { t: 'str', v: literal() };
    if (c === 0x3c) {
      if (s.charCodeAt(i + 1) === 0x3c) { // dictionary: skip balanced << >>
        let d = 0; const st = i;
        while (i < n) {
          if (s.startsWith('<<', i)) { d++; i += 2; } else if (s.startsWith('>>', i)) { d--; i += 2; if (d === 0) break; }
          else if (s[i] === '(') literal(); else i++;
        }
        return { t: 'other', v: s.slice(st, i) };
      }
      return { t: 'str', v: hex() };
    }
    if (c === 0x5b) { // [
      i++;
      const items: Tok[] = [];
      for (;;) {
        skip();
        if (i >= n) break;
        if (s[i] === ']') { i++; break; }
        items.push(value());
      }
      return { t: 'arr', v: items };
    }
    if (c === 0x2f) { // /name
      i++;
      let nm = '';
      while (i < n && isReg(s.charCodeAt(i))) {
        if (s[i] === '#' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { nm += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 3; }
        else nm += s[i++];
      }
      return { t: 'name', v: nm };
    }
    const st = i;
    while (i < n && isReg(s.charCodeAt(i))) i++;
    if (i === st) { i++; return { t: 'other', v: s[st]! }; } // stray delimiter: consume to make progress
    const w = s.slice(st, i);
    if (NUM.test(w)) return { t: 'num', v: Number(w) };
    return { t: 'other', v: w };
  };

  for (;;) {
    skip();
    if (i >= n) break;
    if (opStart < 0) opStart = i;
    const c = s.charCodeAt(i);
    const isOperand = c === 0x28 || c === 0x3c || c === 0x5b || c === 0x2f || c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39);
    const tok = value();
    if (isOperand || tok.t !== 'other') { args.push(tok); continue; }
    const kw = tok.v;
    if (kw === 'true' || kw === 'false' || kw === 'null') { args.push(tok); continue; }
    if (kw === 'BI') { // inline image: skip to "EI" delimited by whitespace
      let j = s.indexOf('ID', i);
      let end = n;
      if (j >= 0) {
        j += 2;
        for (let k = j; k < n - 1; k++) {
          if (s[k] === 'E' && s[k + 1] === 'I' && isWs(s.charCodeAt(k - 1)) && (k + 2 >= n || isWs(s.charCodeAt(k + 2)))) { end = k + 2; break; }
        }
      }
      i = end;
      ops.push({ op: 'BI', args: [], start: opStart, end: i });
      args = []; opStart = -1;
      continue;
    }
    ops.push({ op: kw, args, start: opStart, end: i });
    args = []; opStart = -1;
  }
  return ops;
}

/** Serialise bytes (latin1 chars) as a PDF hex string. */
export const hexString = (bytes: string) => `<${[...bytes].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}>`;
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
export const num = fmt;
