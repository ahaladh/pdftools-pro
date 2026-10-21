import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Select, TextInput } from './fields';
import { readFormFields, type FormField, type FormValue } from './formFields';

export type { FormValue };
export interface FormFill { values: Record<string, FormValue>; flatten: boolean; count: number }

const same = (a: FormValue, b: FormValue) => JSON.stringify(a) === JSON.stringify(b);

/** Lists the fillable fields of a PDF and reports only the values the user changed. */
export function FormFiller({ file, onChange, disabled }: { file: File; onChange: (f: FormFill) => void; disabled?: boolean }) {
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [flatten, setFlatten] = useState(false);

  useEffect(() => {
    let off = false;
    setFields(null); setError(null); setValues({});
    (async () => {
      const r = await readFormFields(new Uint8Array(await file.arrayBuffer()));
      if (off) return;
      if (r === 'xfa') setError('This is an XFA form (a different, dynamic form technology). It cannot be filled here.');
      else setFields(r);
    })().catch(() => { if (!off) setError('This PDF could not be read. If it is password-protected, unlock it first.'); });
    return () => { off = true; };
  }, [file]);

  const changed = useMemo(() => Object.fromEntries((fields ?? []).filter((f) => f.name in values && !same(values[f.name]!, f.initial)).map((f) => [f.name, values[f.name]!])), [fields, values]);
  useEffect(() => { onChange({ values: changed, flatten, count: Object.keys(changed).length }); }, [changed, flatten]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (!fields) return <p className="text-sm text-slate-500" role="status">Reading the form…</p>;
  if (fields.length === 0) return <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">This PDF has no fillable form fields. If it is a scan or looks like a printed form, use <Link className="underline" to="/edit">Edit PDF</Link> to type onto it instead.</p>;

  const set = (name: string, v: FormValue) => setValues((s) => ({ ...s, [name]: v }));
  const cur = (f: FormField) => (f.name in values ? values[f.name]! : f.initial);
  const dis = { disabled };
  return (
    <section aria-label="Form fields" className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-600">Form fields ({fields.length})</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => {
          const multiPage = fields.some((x) => (x.page ?? 1) > 1);
          const label = `${f.name}${multiPage && f.page ? ` (page ${f.page})` : ''}`;
          if (f.kind === 'unsupported' || f.readOnly) return <p key={f.name} className="text-sm text-slate-500"><span className="font-medium">{label}</span>: {f.why ?? 'read-only'}</p>;
          if (f.kind === 'checkbox') return <label key={f.name} className="flex items-center gap-2 text-sm text-slate-800"><input {...dis} type="checkbox" checked={Boolean(cur(f))} onChange={(e) => set(f.name, e.target.checked)} />{label}</label>;
          if (f.kind === 'radio') return (
            <fieldset key={f.name} className="text-sm text-slate-800"><legend className="mb-1.5 font-medium">{label}</legend>
              {f.options.map((o) => <label key={o} className="mr-4 inline-flex items-center gap-1.5"><input {...dis} type="radio" name={f.name} checked={cur(f) === o} onChange={() => set(f.name, o)} />{o}</label>)}
            </fieldset>
          );
          if (f.kind === 'choice') return (
            <Field key={f.name} label={label}>
              {f.multiple
                ? <Select {...dis} multiple value={cur(f) as string[]} onChange={(e) => set(f.name, [...e.target.selectedOptions].map((o) => o.value))}>{f.options.map((o) => <option key={o}>{o}</option>)}</Select>
                : <Select {...dis} value={cur(f) as string} onChange={(e) => set(f.name, e.target.value)}><option value="">—</option>{f.options.map((o) => <option key={o}>{o}</option>)}</Select>}
            </Field>
          );
          return (
            <Field key={f.name} label={label} hint={f.maxLength ? `Up to ${f.maxLength} characters.` : undefined}>
              {f.multiline
                ? <textarea {...dis} rows={3} maxLength={f.maxLength} value={cur(f) as string} onChange={(e) => set(f.name, e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15" />
                : <TextInput {...dis} maxLength={f.maxLength} value={cur(f) as string} onChange={(e) => set(f.name, e.target.value)} />}
            </Field>
          );
        })}
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-800">
        <input {...dis} type="checkbox" className="mt-0.5" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
        <span>Make the answers permanent (flatten)<span className="block text-xs text-slate-600">Removes the fields so the form can no longer be edited. Leave off if the next person still has to fill parts in.</span></span>
      </label>
      <p className="text-xs text-slate-600">Only Latin characters can be written. Your file is processed on our server and deleted afterwards.</p>
    </section>
  );
}
