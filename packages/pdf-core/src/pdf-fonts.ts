import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, StandardFonts, decodePDFRawStream,
  type PDFContext, type PDFObject, type PDFFont,
} from '@cantoo/pdf-lib';

/** Resolve indirect references. */
export const look = (ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined => (o instanceof PDFRef ? ctx.lookup(o) : o);
export const dictGet = (ctx: PDFContext, d: PDFDict | undefined, key: string): PDFObject | undefined => (d ? look(ctx, d.get(PDFName.of(key))) : undefined);
export const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : undefined);
export const numOf = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);

export function streamBytes(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  return (s as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents();
}

export interface FontInfo {
  base: string;
  composite: boolean;
  /** Set when this font cannot be edited safely (the reason is shown to the user). */
  unsupported?: string;
  /** Split a shown string (latin1 chars) into character codes. */
  codes(bytes: string): { code: number; len: number }[];
  uni(code: number): string;
  /** Advance width in 1/1000 em. */
  width(code: number): number;
}

const ASCII_NAMES = 'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde'.split(' ');
const GLYPH = new Map<string, string>(ASCII_NAMES.map((n, i) => [n, String.fromCharCode(32 + i)]));
for (const [n, c] of Object.entries({
  endash: '–', emdash: '—', bullet: '•', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„',
  fi: 'fi', fl: 'fl', ellipsis: '…', copyright: '©', registered: '®', trademark: '™', degree: '°', Euro: '€', sterling: '£', yen: '¥', cent: '¢', section: '§',
  plusminus: '±', multiply: '×', divide: '÷', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedilla: 'ç', odieresis: 'ö', udieresis: 'ü', adieresis: 'ä', germandbls: 'ß', nbspace: ' ', hyphenminus: '-', minus: '−',
})) GLYPH.set(n, c);

export const glyphToUnicode = (name: string): string => {
  const g = GLYPH.get(name);
  if (g) return g;
  const m = /^uni([0-9A-Fa-f]{4})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  return m ? String.fromCodePoint(parseInt(m[1]!, 16)) : '�';
};

const utf16be = (hex: string) => {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
};

/** Parse a ToUnicode CMap (bfchar / bfrange). */
export function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(m[1]!, 16), utf16be(m[2]!));
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = blk[1]!;
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]*>)/g;
    for (const m of body.matchAll(re)) {
      const lo = parseInt(m[1]!, 16), hi = Math.min(parseInt(m[2]!, 16), lo + 0xffff);
      const dst = m[3]!;
      if (dst.startsWith('[')) {
        const arr = [...dst.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => utf16be(x[1]!));
        for (let c = lo; c <= hi && c - lo < arr.length; c++) map.set(c, arr[c - lo]!);
      } else {
        const base = utf16be(dst.slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return map;
}

const decoders: Record<string, TextDecoder> = {};
const decodeByte = (enc: string, b: number) => { try { return (decoders[enc] ??= new TextDecoder(enc)).decode(Uint8Array.of(b)); } catch { return String.fromCharCode(b); } };

let stdDoc: PDFDocument | undefined;
const stdFonts = new Map<string, PDFFont>();
async function standardFont(base: string): Promise<PDFFont> {
  const b = base.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  const bold = /bold|black|heavy|demi/.test(b), italic = /italic|oblique/.test(b);
  const fam = /courier|mono|consolas/.test(b) ? 'Courier' : /times|serif|roman|georgia|garamond|palatino|minion|cambria/.test(b) && !/sans/.test(b) ? 'Times' : 'Helvetica';
  const key = `${fam}${bold ? 'B' : ''}${italic ? 'I' : ''}`;
  let f = stdFonts.get(key);
  if (f) return f;
  stdDoc ??= await PDFDocument.create();
  const name = {
    Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
    Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
    Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  }[fam]![bold && italic ? 3 : bold ? 1 : italic ? 2 : 0]!;
  f = await stdDoc.embedFont(name);
  stdFonts.set(key, f);
  return f;
}

/** Family/weight hint for drawing replacement text, derived from the original font's name. */
export function familyOf(base: string): { family: 'helvetica' | 'times' | 'courier'; bold: boolean; italic: boolean } {
  const b = base.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  return {
    family: /courier|mono|consolas/.test(b) ? 'courier' : /times|serif|roman|georgia|garamond|palatino|minion|cambria/.test(b) && !/sans/.test(b) ? 'times' : 'helvetica',
    bold: /bold|black|heavy|demi/.test(b), italic: /italic|oblique/.test(b),
  };
}

/** Build decoding/metrics for one font dictionary. Never throws: unusable fonts are flagged `unsupported`. */
export async function loadFont(ctx: PDFContext, fd: PDFDict): Promise<FontInfo> {
  const subtype = nameOf(dictGet(ctx, fd, 'Subtype')) ?? '';
  const base = nameOf(dictGet(ctx, fd, 'BaseFont')) ?? 'Unknown';
  const tuObj = dictGet(ctx, fd, 'ToUnicode');
  const toUni = tuObj instanceof PDFStream ? parseToUnicode(Buffer.from(streamBytes(tuObj)).toString('latin1')) : undefined;
  const dead = (why: string): FontInfo => ({ base, composite: false, unsupported: why, codes: (s) => [...s].map((c) => ({ code: c.charCodeAt(0), len: 1 })), uni: () => '�', width: () => 500 });

  if (subtype === 'Type3') return dead('Type 3 fonts');

  if (subtype === 'Type0') {
    const enc = dictGet(ctx, fd, 'Encoding');
    const encName = nameOf(enc);
    if (encName !== 'Identity-H') return dead(`the ${encName ?? 'embedded'} character map`);
    const df = dictGet(ctx, fd, 'DescendantFonts');
    const desc = df instanceof PDFArray ? look(ctx, df.get(0)) : undefined;
    if (!(desc instanceof PDFDict)) return dead('a malformed composite font');
    const dw = numOf(dictGet(ctx, desc, 'DW')) ?? 1000;
    const widths = new Map<number, number>();
    const w = dictGet(ctx, desc, 'W');
    if (w instanceof PDFArray) {
      let i = 0;
      while (i < w.size()) {
        const c = numOf(look(ctx, w.get(i))); const nx = look(ctx, w.get(i + 1));
        if (c === undefined) break;
        if (nx instanceof PDFArray) { for (let k = 0; k < nx.size(); k++) widths.set(c + k, numOf(look(ctx, nx.get(k))) ?? dw); i += 2; }
        else { const hi = numOf(nx), wd = numOf(look(ctx, w.get(i + 2))); if (hi === undefined || wd === undefined) break; for (let k = c; k <= hi && k - c < 65536; k++) widths.set(k, wd); i += 3; }
      }
    }
    if (!toUni) return dead('a font without a text map (ToUnicode)');
    return {
      base, composite: true,
      codes: (s) => { const out: { code: number; len: number }[] = []; for (let i = 0; i + 1 < s.length; i += 2) out.push({ code: (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1), len: 2 }); return out; },
      uni: (c) => toUni.get(c) ?? '�',
      width: (c) => widths.get(c) ?? dw,
    };
  }

  // Simple fonts (Type1, TrueType, MMType1)
  const encObj = dictGet(ctx, fd, 'Encoding');
  let baseEnc = 'windows-1252';
  const diff = new Map<number, string>();
  const applyBase = (n: string | undefined) => { if (n === 'MacRomanEncoding') baseEnc = 'macintosh'; else if (n === 'WinAnsiEncoding' || n === 'StandardEncoding') baseEnc = 'windows-1252'; };
  if (encObj instanceof PDFName) applyBase(encObj.decodeText());
  else if (encObj instanceof PDFDict) {
    applyBase(nameOf(dictGet(ctx, encObj, 'BaseEncoding')));
    const d = dictGet(ctx, encObj, 'Differences');
    if (d instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < d.size(); i++) {
        const o = look(ctx, d.get(i));
        if (o instanceof PDFNumber) code = o.asNumber();
        else if (o instanceof PDFName) diff.set(code++, glyphToUnicode(o.decodeText()));
      }
    }
  }
  const uni = (c: number) => toUni?.get(c) ?? diff.get(c) ?? decodeByte(baseEnc, c);

  const first = numOf(dictGet(ctx, fd, 'FirstChar')) ?? 0;
  const wArr = dictGet(ctx, fd, 'Widths');
  const widths = wArr instanceof PDFArray ? Array.from({ length: wArr.size() }, (_, i) => numOf(look(ctx, wArr.get(i)))) : undefined;
  const fdesc = dictGet(ctx, fd, 'FontDescriptor');
  const missing = fdesc instanceof PDFDict ? numOf(dictGet(ctx, fdesc, 'MissingWidth')) : undefined;
  const std = widths ? undefined : await standardFont(base);
  const width = (c: number) => {
    const w = widths?.[c - first];
    if (w !== undefined) return w;
    if (std) { try { return std.widthOfTextAtSize(uni(c), 1000); } catch { return 500; } }
    return missing ?? 0;
  };
  return { base, composite: false, codes: (s) => [...s].map((ch) => ({ code: ch.charCodeAt(0) & 255, len: 1 })), uni, width };
}
