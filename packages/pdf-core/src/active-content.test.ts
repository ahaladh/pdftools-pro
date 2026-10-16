import { describe, it, expect } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import { stripActiveContent } from './active-content.js';

const js = (doc: PDFDocument, code = 'app.alert("x")') => doc.context.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of(code) });
const raw = async (doc: PDFDocument) => Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');

describe('stripActiveContent', () => {
  it('removes the open action, catalog and page additional-actions, and the document JavaScript tree', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    doc.catalog.set(PDFName.of('OpenAction'), js(doc, 'OPENACTION_JS'));
    doc.catalog.set(PDFName.of('AA'), doc.context.obj({ WC: js(doc, 'CATALOG_AA_JS') }));
    page.node.set(PDFName.of('AA'), doc.context.obj({ O: js(doc, 'PAGE_AA_JS') }));
    doc.catalog.set(PDFName.of('Names'), doc.context.obj({ JavaScript: doc.context.obj({ Names: [PDFString.of('x'), js(doc, 'NAMETREE_JS')] }) }));
    const n = stripActiveContent(doc);
    expect(n).toBe(4);
    const out = await raw(doc);
    for (const marker of ['OPENACTION_JS', 'CATALOG_AA_JS', 'PAGE_AA_JS', 'NAMETREE_JS']) expect(out, marker).not.toContain(marker);
  });

  it('removes JavaScript/Launch actions on links, bookmarks and indirect field actions, but keeps ordinary links', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const link = (action: unknown) => doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 20], A: action }));
    const keep = link(doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/keep-me') }));
    const bad1 = link(js(doc, 'LINK_JS'));
    const bad2 = link(doc.context.obj({ Type: 'Action', S: 'Launch', F: PDFString.of('LAUNCH_TARGET.exe') }));
    const indirectAction = doc.context.register(js(doc, 'INDIRECT_JS'));
    const field = doc.context.register(doc.context.obj({ FT: 'Btn', T: PDFString.of('b'), A: indirectAction }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([keep, bad1, bad2, field]));
    expect(stripActiveContent(doc)).toBe(3);
    const out = await raw(doc);
    expect(out).toContain('https://example.com/keep-me');
    for (const marker of ['LINK_JS', 'LAUNCH_TARGET', 'INDIRECT_JS']) expect(out, marker).not.toContain(marker);
    // the annotations themselves survive
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(4);
    expect((annots.lookup(0, PDFDict)).get(PDFName.of('A'))).toBeDefined();
    expect((annots.lookup(1, PDFDict)).get(PDFName.of('A'))).toBeUndefined();
  });

  it('does nothing to a document with no active content', async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    expect(stripActiveContent(doc)).toBe(0);
  });
});
