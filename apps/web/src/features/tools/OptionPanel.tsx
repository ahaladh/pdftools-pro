import { Field, Radio, Select, TextInput } from './fields';

type O = Record<string, unknown>;
interface Props { tool: string; value: O; onChange: (v: O) => void; disabled?: boolean }

export const DEFAULT_OPTIONS: Record<string, O> = {
  merge: {},
  split: { mode: 'each', ranges: '', every: 1 },
  compress: { preset: 'recommended', stripMetadata: false },
  rotate: { angle: 90, pages: 'all' },
  organize: {},
  'extract-pages': { pages: '' },
  'page-numbers': { position: 'bottom-center', start: 1, format: 'n', fontSize: 11, pages: 'all' },
  watermark: { text: 'CONFIDENTIAL', opacity: 0.25, fontSize: 60, rotation: 45, color: '#888888', pages: 'all' },
  'images-to-pdf': { pageSize: 'fit', margin: 0 },
  'pdf-to-images': { format: 'jpg', dpi: 150, pages: 'all' },
  'office-to-pdf': {}, 'pdf-to-text': {}, 'pdf-to-html': {}, 'edit-content': {}, 'pdf-to-word': {}, 'pdf-to-excel': {}, 'pdf-to-powerpoint': {}, 'extract-images': {}, flatten: {}, compare: {}, repair: {},
  protect: { password: '', confirm: '' },
  unlock: { password: '', confirmAuthorized: false },
  crop: { top: 0, right: 0, bottom: 0, left: 0, pages: 'all' },
  resize: { size: 'a4', pages: 'all' },
  'add-blank-pages': { count: 1, where: 'end', after: 1 },
};

/** Cross-field checks the schema can't express; returns an error message or null. */
export function preflight(tool: string, v: O): string | null {
  if (tool === 'protect') {
    if (!v.password) return 'Enter a password.';
    if (v.password !== v.confirm) return 'The passwords do not match.';
  }
  return null;
}

/** Convert UI state into the API options shape. */
export function toApiOptions(tool: string, v: O): O {
  if (tool === 'protect') return { password: v.password };
  if (tool === 'add-blank-pages') return { count: v.count, ...(v.where === 'start' ? { after: 0 } : v.where === 'after' ? { after: v.after } : {}) };
  return v;
}

/** Tool-specific settings. Values are validated again against the shared Zod schema before submit. */
export function OptionPanel({ tool, value, onChange, disabled }: Props) {
  const set = (patch: O) => onChange({ ...value, ...patch });
  const v = value as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const dis = { disabled };
  switch (tool) {
    case 'split':
      return (
        <div className="space-y-4">
          <Radio name="Split mode" value={v.mode as 'each' | 'every' | 'ranges'} onChange={(mode) => set({ mode })} options={[
            { value: 'each', label: 'Every page', desc: 'One PDF per page' },
            { value: 'every', label: 'Every N pages', desc: 'Fixed-size chunks' },
            { value: 'ranges', label: 'Custom ranges', desc: 'Each comma-separated part becomes its own file' },
          ]} />
          {v.mode === 'every' && <Field label="Pages per file"><TextInput {...dis} type="number" min={1} value={v.every} onChange={(e) => set({ every: Number(e.target.value) })} /></Field>}
          {v.mode === 'ranges' && <Field label="Page ranges" hint="Example: 1-3, 5, 8-  → three files"><TextInput {...dis} value={v.ranges} onChange={(e) => set({ ranges: e.target.value })} placeholder="1-3, 5, 8-" /></Field>}
        </div>
      );
    case 'compress':
      return (
        <div className="space-y-4">
          <Radio name="Compression level" value={v.preset as 'recommended'} onChange={(preset) => set({ preset })} options={[
            { value: 'maximum-quality', label: 'Maximum quality', desc: 'Least reduction, best fidelity' },
            { value: 'recommended', label: 'Recommended', desc: 'Balanced size and quality' },
            { value: 'maximum-compression', label: 'Maximum compression', desc: 'Smallest file, lower image quality' },
          ]} />
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input {...dis} type="checkbox" checked={Boolean(v.stripMetadata)} onChange={(e) => set({ stripMetadata: e.target.checked })} />
            Remove document metadata (title, author, producer)
          </label>
        </div>
      );
    case 'rotate':
      return (
        <div className="space-y-4">
          <Field label="Rotation"><Select {...dis} value={v.angle} onChange={(e) => set({ angle: Number(e.target.value) })}>
            <option value={90}>90° clockwise</option><option value={180}>180°</option><option value={270}>90° counter-clockwise</option>
          </Select></Field>
          <Field label="Pages" hint='"all" or ranges like 1-3, 7'><TextInput {...dis} value={v.pages} onChange={(e) => set({ pages: e.target.value })} /></Field>
        </div>
      );
    case 'extract-pages':
      return <Field label="Pages to extract" hint="Example: 1-3, 5, 8-"><TextInput {...dis} value={v.pages} onChange={(e) => set({ pages: e.target.value })} placeholder="1-3, 5" /></Field>;
    case 'page-numbers':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Position"><Select {...dis} value={v.position} onChange={(e) => set({ position: e.target.value })}>
            {['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-left', 'top-right'].map((p) => <option key={p} value={p}>{p.replace('-', ' ')}</option>)}
          </Select></Field>
          <Field label="Format"><Select {...dis} value={v.format} onChange={(e) => set({ format: e.target.value })}>
            <option value="n">1</option><option value="page-n">Page 1</option><option value="n-of-total">1 of N</option>
          </Select></Field>
          <Field label="First number"><TextInput {...dis} type="number" min={0} value={v.start} onChange={(e) => set({ start: Number(e.target.value) })} /></Field>
          <Field label="Font size"><TextInput {...dis} type="number" min={6} max={48} value={v.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} /></Field>
          <div className="sm:col-span-2"><Field label="Pages" hint='"all" or ranges'><TextInput {...dis} value={v.pages} onChange={(e) => set({ pages: e.target.value })} /></Field></div>
        </div>
      );
    case 'watermark':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Watermark text" hint="Latin characters only (standard PDF font)"><TextInput {...dis} maxLength={100} value={v.text} onChange={(e) => set({ text: e.target.value })} /></Field></div>
          <Field label={`Opacity (${Math.round(Number(v.opacity) * 100)}%)`}><input {...dis} className="w-full" type="range" min={0.05} max={1} step={0.05} value={v.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} /></Field>
          <Field label="Font size"><TextInput {...dis} type="number" min={8} max={200} value={v.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} /></Field>
          <Field label="Rotation (degrees)"><TextInput {...dis} type="number" min={-90} max={90} value={v.rotation} onChange={(e) => set({ rotation: Number(e.target.value) })} /></Field>
          <Field label="Colour"><TextInput {...dis} type="color" className="h-10 p-1" value={v.color} onChange={(e) => set({ color: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Pages" hint='"all" or ranges'><TextInput {...dis} value={v.pages} onChange={(e) => set({ pages: e.target.value })} /></Field></div>
        </div>
      );
    case 'images-to-pdf':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Page size"><Select {...dis} value={v.pageSize} onChange={(e) => set({ pageSize: e.target.value })}>
            <option value="fit">Same as image</option><option value="a4">A4</option><option value="letter">US Letter</option>
          </Select></Field>
          <Field label="Margin (points)"><TextInput {...dis} type="number" min={0} max={100} value={v.margin} onChange={(e) => set({ margin: Number(e.target.value) })} /></Field>
        </div>
      );
    case 'pdf-to-images':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Format"><Select {...dis} value={v.format} onChange={(e) => set({ format: e.target.value })}><option value="jpg">JPG</option><option value="png">PNG</option></Select></Field>
          <Field label="Resolution (DPI)" hint="150 for screens, 300 for print"><TextInput {...dis} type="number" min={36} max={300} value={v.dpi} onChange={(e) => set({ dpi: Number(e.target.value) })} /></Field>
          <div className="sm:col-span-2"><Field label="Pages" hint='"all" or ranges'><TextInput {...dis} value={v.pages} onChange={(e) => set({ pages: e.target.value })} /></Field></div>
        </div>
      );
    case 'protect':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password"><TextInput {...dis} type="password" autoComplete="new-password" value={v.password} onChange={(e) => set({ password: e.target.value })} /></Field>
          <Field label="Confirm password"><TextInput {...dis} type="password" autoComplete="new-password" value={v.confirm} onChange={(e) => set({ confirm: e.target.value })} /></Field>
          <p className="text-xs text-slate-500 sm:col-span-2">AES-256 encryption. We cannot recover a lost password, and the password is deleted from our job record when processing ends.</p>
        </div>
      );
    case 'unlock':
      return (
        <div className="space-y-4">
          <Field label="Document password" hint="We can only unlock a file when you provide the correct password. We cannot recover or bypass passwords."><TextInput {...dis} type="password" autoComplete="off" value={v.password} onChange={(e) => set({ password: e.target.value })} /></Field>
          <label className="flex items-start gap-2 text-sm text-slate-800"><input {...dis} className="mt-1" type="checkbox" checked={Boolean(v.confirmAuthorized)} onChange={(e) => set({ confirmAuthorized: e.target.checked })} />I am authorized to open and remove the protection from this document.</label>
        </div>
      );
    case 'crop':
      return (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(['top', 'right', 'bottom', 'left'] as const).map((k) => <Field key={k} label={`${k[0]!.toUpperCase()}${k.slice(1)} (%)`}><TextInput {...dis} type="number" min={0} max={90} value={v[k]} onChange={(e) => set({ [k]: Number(e.target.value) })} /></Field>)}
          <div className="col-span-2 sm:col-span-4"><Field label="Pages" hint='"all" or ranges'><TextInput {...dis} value={v.pages} onChange={(e) => set({ pages: e.target.value })} /></Field></div>
          <p className="col-span-2 text-xs text-slate-500 sm:col-span-4">Cropping hides the outside area but does not delete it. Use Redact to remove content permanently.</p>
        </div>
      );
    case 'resize':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paper size"><Select {...dis} value={v.size} onChange={(e) => set({ size: e.target.value })}>
            <option value="a3">A3</option><option value="a4">A4</option><option value="a5">A5</option><option value="letter">US Letter</option><option value="legal">US Legal</option>
          </Select></Field>
          <Field label="Pages" hint='"all" or ranges'><TextInput {...dis} value={v.pages} onChange={(e) => set({ pages: e.target.value })} /></Field>
        </div>
      );
    case 'add-blank-pages':
      return (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="How many"><TextInput {...dis} type="number" min={1} max={100} value={v.count} onChange={(e) => set({ count: Number(e.target.value) })} /></Field>
          <Field label="Where"><Select {...dis} value={v.where} onChange={(e) => set({ where: e.target.value })}><option value="end">At the end</option><option value="start">At the start</option><option value="after">After page…</option></Select></Field>
          {v.where === 'after' && <Field label="After page"><TextInput {...dis} type="number" min={1} value={v.after} onChange={(e) => set({ after: Number(e.target.value) })} /></Field>}
        </div>
      );
    default:
      return <p className="text-sm text-slate-600">No settings needed. Just add your files and run.</p>;
  }
}
