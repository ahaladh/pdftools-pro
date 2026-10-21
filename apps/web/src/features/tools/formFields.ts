export type FormValue = string | boolean | string[];

export interface FormField {
  /** Fully-qualified name, exactly as the server looks it up. */
  name: string;
  kind: 'text' | 'checkbox' | 'radio' | 'choice' | 'unsupported';
  /** 1-based page of the first widget, when it can be determined. */
  page?: number;
  readOnly: boolean;
  multiline: boolean;
  maxLength?: number;
  options: string[];
  multiple: boolean;
  initial: FormValue;
  /** Why the field cannot be filled in here (shown instead of an input). */
  why?: string;
}

/**
 * Lists a PDF's fillable fields using the same library the server fills them with (lazy-loaded), so field names,
 * radio/dropdown option names and initial values are exactly what the server will accept. Returns 'xfa' for XFA forms.
 */
export async function readFormFields(bytes: Uint8Array): Promise<FormField[] | 'xfa'> {
  const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFSignature, PDFButton } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, preserveXFA: true });
  const form = doc.getForm();
  if (form.hasXFA()) return 'xfa';
  const pageOf = new Map(doc.getPages().map((p, i) => [p.ref, i + 1] as const));
  return form.getFields().map((f): FormField => {
    const base = { name: f.getName(), readOnly: f.isReadOnly(), multiline: false, options: [] as string[], multiple: false,
      page: pageOf.get(f.acroField.getWidgets()[0]?.P() as never) };
    if (f instanceof PDFTextField) return { ...base, kind: 'text', multiline: f.isMultiline(), maxLength: f.getMaxLength(), initial: f.getText() ?? '' };
    if (f instanceof PDFCheckBox) return { ...base, kind: 'checkbox', initial: f.isChecked() };
    if (f instanceof PDFRadioGroup) return { ...base, kind: 'radio', options: f.getOptions(), initial: f.getSelected() ?? '' };
    if (f instanceof PDFDropdown) return { ...base, kind: 'choice', options: f.getOptions(), initial: f.getSelected()[0] ?? '' };
    if (f instanceof PDFOptionList) return { ...base, kind: 'choice', multiple: f.isMultiselect(), options: f.getOptions(), initial: f.isMultiselect() ? f.getSelected() : (f.getSelected()[0] ?? '') };
    return { ...base, kind: 'unsupported', initial: '', why: f instanceof PDFSignature ? 'Signature fields cannot be filled here' : f instanceof PDFButton ? 'Button' : 'Not a fillable field type' };
  });
}
