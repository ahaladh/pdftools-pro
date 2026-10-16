import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import { look, nameOf } from './pdf-fonts.js';
import { reachableTags } from './pdf-graph.js';

/** Action types PDF/A forbids (ISO 19005-1 §6.6.1 / -2 §6.5.1). Navigation actions (GoTo, URI, Named) are fine and are kept. */
const FORBIDDEN = new Set(['JavaScript', 'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData']);

const isForbiddenAction = (ctx: PDFContext, a: PDFObject | undefined): boolean => {
  const d = look(ctx, a);
  return d instanceof PDFDict && FORBIDDEN.has(nameOf(look(ctx, d.get(PDFName.of('S')))) ?? '');
};

/**
 * Remove active content from a document, in place: forbidden actions wherever they are referenced (catalog open action,
 * links, bookmarks, form fields, pages), every additional-actions (/AA) dictionary, and the document JavaScript name tree.
 * We do this ourselves instead of relying on a converter, whose handling differs between versions (Ghostscript 10 keeps a
 * dead copy of the open action under an unknown catalog key). Returns how many items were removed.
 */
export function stripActiveContent(doc: PDFDocument): number {
  const ctx = doc.context;
  let removed = 0;
  const dropped: PDFRef[] = []; // indirect objects we cut loose; deleted below if nothing else reaches them
  const visit = (d: PDFDict | undefined) => {
    if (!d) return;
    for (const key of ['A', 'OpenAction']) {
      const v = d.get(PDFName.of(key));
      if (isForbiddenAction(ctx, v)) { if (v instanceof PDFRef) dropped.push(v); d.delete(PDFName.of(key)); removed++; }
    }
    const aa = d.get(PDFName.of('AA'));
    if (aa) { if (aa instanceof PDFRef) dropped.push(aa); collectRefs(look(ctx, aa)); d.delete(PDFName.of('AA')); removed++; }
  };
  const collectRefs = (o: PDFObject | undefined) => { if (o instanceof PDFDict) for (const [, v] of o.entries()) if (v instanceof PDFRef) dropped.push(v); };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined);
  visit(doc.catalog); // direct entries of the catalog are not separate objects
  const names = look(ctx, doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict && names.has(PDFName.of('JavaScript'))) {
    const walk = (o: PDFObject | undefined, depth = 0) => {
      if (depth > 8 || !o) return;
      if (o instanceof PDFRef) { dropped.push(o); walk(ctx.lookup(o), depth + 1); return; }
      if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) walk(o.get(i), depth + 1);
      else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v, depth + 1);
    };
    walk(names.get(PDFName.of('JavaScript')));
    names.delete(PDFName.of('JavaScript')); removed++;
  }
  // An open action may also be an array destination or a direct dict inside another direct dict; one level deeper is enough in practice.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const kids = obj.get(PDFName.of('Annots'));
    const arr = look(ctx, kids);
    if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) { const a = look(ctx, arr.get(i)); if (a instanceof PDFDict) visit(a); }
  }
  if (dropped.length) {
    const live = reachableTags(ctx);
    for (const ref of dropped) if (!live.has(ref.tag)) ctx.delete(ref);
  }
  return removed;
}
