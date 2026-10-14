import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, Info, Trash2, Undo2 } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { openPdf, pdfjs } from '@/features/tools/pdfjs';
import { Field, Select, TextInput } from '@/features/tools/fields';
import { buildContentPayload, imageBox, textBox, type ContentBuilt, type FracBox, type ImageChange, type Matrix, type TextChange } from './model';

interface Run { id: string; str: string; box: FracBox }
interface Pic { id: string; box: FracBox }
interface PageData { w: number; h: number; runs: Run[]; pics: Pic[] }

const OPS = pdfjs.OPS;
/** Text runs and top-level images of one page, as fractions of the displayed page. */
async function readPage(doc: PDFDocumentProxy, pageNo: number): Promise<PageData> {
  const page = await doc.getPage(pageNo + 1);
  const vp = page.getViewport({ scale: 1 });
  const vpm = vp.transform as Matrix;
  const tc = await page.getTextContent();
  const runs: Run[] = [];
  tc.items.forEach((it, i) => {
    if (!('str' in it) || !it.str.trim() || it.width <= 0) return;
    runs.push({ id: `${pageNo}:t${i}`, str: it.str, box: textBox(vpm, vp.width, vp.height, it.transform as Matrix, it.width) });
  });
  const ol = await page.getOperatorList();
  const pics: Pic[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let formDepth = 0;
  const formStack: number[] = [];
  ol.fnArray.forEach((fn, i) => {
    const a = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) { const m = a as Matrix; ctm = [m[0] * ctm[0] + m[1] * ctm[2], m[0] * ctm[1] + m[1] * ctm[3], m[2] * ctm[0] + m[3] * ctm[2], m[2] * ctm[1] + m[3] * ctm[3], m[4] * ctm[0] + m[5] * ctm[2] + ctm[4], m[4] * ctm[1] + m[5] * ctm[3] + ctm[5]]; }
    else if (fn === OPS.paintFormXObjectBegin) { formDepth++; formStack.push(stack.length); stack.push(ctm); }
    else if (fn === OPS.paintFormXObjectEnd) { formDepth = Math.max(0, formDepth - 1); formStack.pop(); ctm = stack.pop() ?? ctm; }
    else if (fn === OPS.paintImageXObject && formDepth === 0) pics.push({ id: `${pageNo}:i${pics.length}`, box: imageBox(vpm, vp.width, vp.height, ctm) });
  });
  return { w: vp.width, h: vp.height, runs, pics };
}

const DEFAULT_STYLE = { font: 'auto' as const, bold: null as boolean | null, italic: null as boolean | null, size: null as number | null, color: null as string | null };
const tri = (v: boolean | null) => (v === null ? 'auto' : v ? 'yes' : 'no');
const untri = (v: string) => (v === 'auto' ? null : v === 'yes');

interface Props { file: File; disabled?: boolean; onChange: (built: ContentBuilt) => void }

/** Click text in the page to retype it; click an image to delete or replace it. Coordinates are page fractions. */
export function ContentEditor({ file, disabled, onChange }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNo, setPageNo] = useState(0);
  const [data, setData] = useState<PageData | null>(null);
  const [width, setWidth] = useState(720);
  const [selected, setSelected] = useState<string | null>(null);
  // edits keyed by the run/picture id so they survive page changes
  const [texts, setTexts] = useState<Record<string, TextChange>>({});
  const [imgs, setImgs] = useState<Record<string, ImageChange>>({});
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let dead = false;
    setDoc(null); setError(null); setPageNo(0); setTexts({}); setImgs({}); setSelected(null);
    openPdf(file).then((d) => !dead && setDoc(d)).catch(() => !dead && setError('This PDF could not be opened. It may be encrypted or damaged.'));
    return () => { dead = true; };
  }, [file]);

  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, Math.min(900, el.clientWidth))));
    ro.observe(el); setWidth(Math.max(280, Math.min(900, el.clientWidth)));
    return () => ro.disconnect();
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    let dead = false;
    setData(null); setSelected(null);
    readPage(doc, pageNo).then((d) => !dead && setData(d)).catch(() => !dead && setError('This page could not be read.'));
    return () => { dead = true; };
  }, [doc, pageNo]);

  const scale = data ? width / data.w : 1;
  useEffect(() => {
    if (!doc || !data || !canvas.current) return;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null; let dead = false;
    void doc.getPage(pageNo + 1).then((page) => {
      if (dead || !canvas.current) return;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      task.promise.catch(() => undefined);
    });
    return () => { dead = true; task?.cancel(); };
  }, [doc, data, scale, pageNo]);

  const built = useMemo(() => buildContentPayload(Object.values(texts), Object.values(imgs)), [texts, imgs]);
  useEffect(() => { onChange(built); }, [built]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (!doc) return <p className="text-sm text-slate-500" role="status">Loading document…</p>;
  const total = doc.numPages;
  const run = data?.runs.find((r) => r.id === selected);
  const pic = data?.pics.find((p) => p.id === selected);
  const edit = selected ? texts[selected] : undefined;
  const picEdit = selected ? imgs[selected] : undefined;
  const changes = built.count;

  const setText = (r: Run, patch: Partial<TextChange>) => setTexts((cur) => {
    const base = cur[r.id] ?? { page: pageNo, box: r.box, original: r.str, replacement: r.str, ...DEFAULT_STYLE };
    const next = { ...base, ...patch };
    const unchanged = next.replacement === next.original && next.font === 'auto' && next.bold === null && next.italic === null && next.size === null && next.color === null;
    if (unchanged) { const { [r.id]: _drop, ...rest } = cur; return rest; }
    return { ...cur, [r.id]: next };
  });
  const setImg = (p: Pic, patch: Partial<ImageChange> | null) => setImgs((cur) => {
    if (patch === null) { const { [p.id]: _drop, ...rest } = cur; return rest; }
    return { ...cur, [p.id]: { page: pageNo, box: p.box, action: 'delete', fit: 'contain', ...cur[p.id], ...patch } };
  });
  const pct = (b: FracBox) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-xl bg-sky-50 p-3 text-sm text-sky-900"><Info className="mt-0.5 h-4 w-4 shrink-0" />
        Click text on the page to retype it, or click a picture to delete or replace it. The original text is removed from the page content, and new text uses Helvetica, Times or Courier matched to the original. Text can only be edited in PDFs that contain real text, not scans.</p>

      <div role="toolbar" aria-label="Page navigation" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
        <Button size="sm" variant="ghost" aria-label="Previous page" disabled={pageNo === 0 || disabled} onClick={() => setPageNo(pageNo - 1)}><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-sm">Page {pageNo + 1} of {total}</span>
        <Button size="sm" variant="ghost" aria-label="Next page" disabled={pageNo >= total - 1 || disabled} onClick={() => setPageNo(pageNo + 1)}><ChevronRight className="h-4 w-4" /></Button>
        <span className="ml-auto text-sm text-slate-600" aria-live="polite">{changes} change{changes === 1 ? '' : 's'} so far</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div ref={wrap} className="min-w-0 overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-3" style={{ maxHeight: '78vh' }}>
          {!data ? <p className="text-sm text-slate-500" role="status">Reading page…</p> : (
            <div className="relative mx-auto bg-white shadow" style={{ width: data.w * scale, height: data.h * scale }} data-testid="content-page">
              <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-label={`Page ${pageNo + 1}`} />
              {data.pics.map((p, i) => {
                const e = imgs[p.id];
                return (
                  <button key={p.id} type="button" disabled={disabled} aria-label={`Image ${i + 1}${e ? (e.action === 'delete' ? ' (will be deleted)' : ' (will be replaced)') : ''}`} aria-pressed={selected === p.id}
                    className={cn('absolute bg-transparent p-0 rounded border-2 border-dashed border-violet-500/70 hover:bg-violet-500/10 focus-visible:outline focus-visible:outline-2', selected === p.id && 'bg-violet-500/15', e?.action === 'delete' && 'border-red-600 bg-red-500/30', e?.action === 'replace' && 'border-emerald-600 bg-emerald-500/20')}
                    style={pct(p.box)} onClick={() => setSelected(p.id)} />
                );
              })}
              {data.runs.map((r) => {
                const e = texts[r.id];
                return (
                  <button key={r.id} type="button" disabled={disabled} aria-label={`Edit text: ${r.str}`} aria-pressed={selected === r.id} title={e ? `Will become: ${e.replacement || '(deleted)'}` : r.str}
                    className={cn('absolute border-0 bg-transparent p-0 rounded-sm outline-1 hover:bg-amber-300/30 hover:outline hover:outline-amber-500 focus-visible:outline focus-visible:outline-2', selected === r.id && 'bg-amber-300/40 outline outline-2 outline-amber-600', e && 'bg-emerald-400/30 outline outline-1 outline-emerald-600')}
                    style={pct(r.box)} onClick={() => setSelected(r.id)} />
                );
              })}
              {data.runs.length === 0 && data.pics.length === 0 && (
                <p className="absolute inset-x-4 bottom-4 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" role="status">No editable text or images were found on this page. If it is a scan, it is a picture and cannot be edited.</p>
              )}
            </div>
          )}
        </div>

        <aside className="space-y-3" aria-label="Edit details">
          {run && (
            <div className="space-y-3 rounded-xl border border-slate-200 p-3">
              <Field label="Text">
                <textarea aria-label="Replacement text" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" rows={2} maxLength={2000} disabled={disabled}
                  value={edit?.replacement ?? run.str} onChange={(e) => setText(run, { replacement: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Font"><Select value={edit?.font ?? 'auto'} disabled={disabled} onChange={(e) => setText(run, { font: e.target.value as TextChange['font'] })}><option value="auto">Match original</option><option value="helvetica">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></Select></Field>
                <Field label="Size (pt)"><TextInput type="number" min={2} max={300} placeholder="auto" disabled={disabled} value={edit?.size ?? ''} onChange={(e) => setText(run, { size: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
                <Field label="Bold"><Select value={tri(edit?.bold ?? null)} disabled={disabled} onChange={(e) => setText(run, { bold: untri(e.target.value) })}><option value="auto">Match original</option><option value="yes">Bold</option><option value="no">Regular</option></Select></Field>
                <Field label="Italic"><Select value={tri(edit?.italic ?? null)} disabled={disabled} onChange={(e) => setText(run, { italic: untri(e.target.value) })}><option value="auto">Match original</option><option value="yes">Italic</option><option value="no">Upright</option></Select></Field>
              </div>
              <Field label="Colour"><div className="flex items-center gap-2">
                <TextInput type="color" className="h-9 w-14 p-1" disabled={disabled} value={edit?.color ?? '#000000'} onChange={(e) => setText(run, { color: e.target.value })} />
                {edit?.color && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setText(run, { color: null })}>Match original</Button>}
              </div></Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setText(run, { replacement: '' })}><Trash2 className="h-4 w-4" />Delete this text</Button>
                {edit && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setTexts((c) => { const { [run.id]: _d, ...rest } = c; return rest; })}><Undo2 className="h-4 w-4" />Undo change</Button>}
              </div>
            </div>
          )}
          {pic && (
            <div className="space-y-3 rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-medium">Image on page {pageNo + 1}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={picEdit?.action === 'delete' ? 'primary' : 'secondary'} disabled={disabled} aria-pressed={picEdit?.action === 'delete'} onClick={() => setImg(pic, { action: 'delete', file: undefined })}><Trash2 className="h-4 w-4" />Delete image</Button>
                <Button size="sm" variant={picEdit?.action === 'replace' ? 'primary' : 'secondary'} disabled={disabled} aria-pressed={picEdit?.action === 'replace'} onClick={() => fileInput.current?.click()}><ImagePlus className="h-4 w-4" />Replace…</Button>
                {picEdit && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setImg(pic, null)}><Undo2 className="h-4 w-4" />Undo change</Button>}
              </div>
              <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a replacement image" accept="image/png,image/jpeg"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setImg(pic, { action: 'replace', file: f }); e.target.value = ''; }} />
              {picEdit?.action === 'replace' && picEdit.file && (<>
                <p className="text-xs text-slate-600">Replacement: {picEdit.file.name}</p>
                <Field label="Fit"><Select value={picEdit.fit} disabled={disabled} onChange={(e) => setImg(pic, { fit: e.target.value as 'contain' | 'stretch' })}><option value="contain">Keep proportions</option><option value="stretch">Stretch to fill the frame</option></Select></Field>
              </>)}
              {picEdit?.action === 'replace' && !picEdit.file && <p className="text-xs text-amber-800">Choose an image file to finish this replacement.</p>}
            </div>
          )}
          {!run && !pic && <p className="rounded-xl border border-dashed border-slate-300 p-3 text-sm text-slate-600">Select text or a picture on the page.</p>}
        </aside>
      </div>
    </div>
  );
}
