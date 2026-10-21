import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { readFormFields } from './formFields';

async function build(fn: (form: ReturnType<PDFDocument['getForm']>, page: ReturnType<PDFDocument['addPage']>) => void, xfa = false) {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([400, 500]); const page2 = doc.addPage([400, 500]);
  fn(doc.getForm(), page1);
  doc.getForm().createTextField('second').addToPage(page2, { x: 10, y: 10, width: 100, height: 20 });
  const bytes = new Uint8Array(await doc.save());
  if (!xfa) return bytes;
  // save() drops XFA from documents not loaded with preserveXFA, so add it to a reloaded copy.
  const re = await PDFDocument.load(bytes, { preserveXFA: true });
  re.getForm().acroForm.dict.set(PDFName.of('XFA'), re.context.obj([]));
  return new Uint8Array(await re.save());
}

describe('readFormFields', () => {
  it('lists each field type with the names, options and values the server will accept', async () => {
    const bytes = await build((form, page) => {
      const t = form.createTextField('person.name'); t.setText('Ann'); t.setMaxLength(10); t.addToPage(page, { x: 10, y: 440, width: 100, height: 20 });
      form.createCheckBox('agree').addToPage(page, { x: 10, y: 400, width: 14, height: 14 });
      const rg = form.createRadioGroup('plan'); rg.addOptionToPage('basic', page, { x: 10, y: 360, width: 14, height: 14 }); rg.addOptionToPage('premium', page, { x: 60, y: 360, width: 14, height: 14 }); rg.select('premium');
      const dd = form.createDropdown('country'); dd.addOptions(['India', 'Norway']); dd.select('Norway'); dd.addToPage(page, { x: 10, y: 300, width: 100, height: 20 });
      const ol = form.createOptionList('tags'); ol.addOptions(['a', 'b']); ol.enableMultiselect(); ol.addToPage(page, { x: 10, y: 200, width: 100, height: 50 });
      form.createButton('go').addToPage('Go', page, { x: 10, y: 150, width: 40, height: 20 });
    });
    const f = await readFormFields(bytes);
    if (f === 'xfa') throw new Error('unexpected');
    const by = Object.fromEntries(f.map((x) => [x.name, x]));
    expect(by['person.name']).toMatchObject({ kind: 'text', initial: 'Ann', maxLength: 10, page: 1 });
    expect(by['agree']).toMatchObject({ kind: 'checkbox', initial: false });
    // The state names inside the file are indices; the option names must be the labels, which is what the server checks against.
    expect(by['plan']).toMatchObject({ kind: 'radio', options: ['basic', 'premium'], initial: 'premium' });
    expect(by['country']).toMatchObject({ kind: 'choice', options: ['India', 'Norway'], initial: 'Norway', multiple: false });
    expect(by['tags']).toMatchObject({ kind: 'choice', multiple: true, options: ['a', 'b'], initial: [] });
    expect(by['go']).toMatchObject({ kind: 'unsupported' });
    expect(by['second']!.page).toBe(2);
  });

  it('reports XFA forms instead of silently dropping the XFA data', async () => {
    const bytes = await build((form, page) => { form.createTextField('x').addToPage(page, { x: 1, y: 1, width: 50, height: 20 }); }, true);
    expect(await readFormFields(bytes)).toBe('xfa');
  });

  it('returns an empty list for a PDF without fields', async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    expect(await readFormFields(new Uint8Array(await doc.save()))).toEqual([]);
  });
});
