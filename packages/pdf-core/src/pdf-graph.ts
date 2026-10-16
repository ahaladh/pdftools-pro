import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFContext, type PDFObject } from '@cantoo/pdf-lib';

/** Tags of every indirect object reachable from the trailer (catalog, info, encryption). Anything else is dead weight in the file. */
export function reachableTags(ctx: PDFContext): Set<string> {
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo as { Root?: PDFObject; Info?: PDFObject; Encrypt?: PDFObject };
  for (const r of [t.Root, t.Info, t.Encrypt]) if (r) stack.push(r);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) { if (seen.has(o.tag)) continue; seen.add(o.tag); const t2 = ctx.lookup(o); if (t2) stack.push(t2); continue; }
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) stack.push(o.get(i)); continue; }
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined;
    if (d) for (const [, v] of d.entries()) stack.push(v);
  }
  return seen;
}
