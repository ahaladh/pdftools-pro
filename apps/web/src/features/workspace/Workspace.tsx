import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle, Highlighter, ImagePlus, Minus, MousePointer2, PenLine, Redo2, Square, Trash2, Type, Undo2, ZoomIn, ZoomOut,
  Maximize, MoveHorizontal, ChevronLeft, ChevronRight, ShieldAlert, Signature, EyeOff,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { openPdf } from '@/features/tools/pdfjs';
import { Field, Select, TextInput } from '@/features/tools/fields';
import { SignaturePad } from './SignaturePad';
import {
  buildPayload, hasBox, isRedaction, move, normRect, resizeTo, simplify, bounds,
  type A, type Built, type Item, type Mode, type R, type Tool,
} from './model';

interface Props { mode: Mode; file: File; disabled?: boolean; onChange: (built: Built) => void }
type Zoom = 'width' | 'page' | number;

const FONT_CSS = { helvetica: 'Helvetica, Arial, sans-serif', times: '"Times New Roman", Times, serif', courier: '"Courier New", Courier, monospace' } as const;
const uid = () => Math.random().toString(36).slice(2, 10);

interface Defaults { color: string; stroke: string; fill: string | null; strokeWidth: number; opacity: number; fontSize: number; font: keyof typeof FONT_CSS; highlight: string }
const DEFAULTS: Defaults = { color: '#111827', stroke: '#dc2626', fill: null, strokeWidth: 2, opacity: 1, fontSize: 16, font: 'helvetica', highlight: '#fde047' };

/** Viewer + editor. Annotation coordinates are page fractions so they are independent of zoom. */
export function Workspace({ mode, file, disabled, onChange }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNo, setPageNo] = useState(0);
  const [zoom, setZoom] = useState<Zoom>('width');
  const [tool, setTool] = useState<Tool>('select');
  const [defaults, setDefaults] = useState<Defaults>(DEFAULTS);
  const [dpi, setDpi] = useState(150);
  const [searchText, setSearchText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [images, setImages] = useState<{ file: File; url: string }[]>([]);
  const [pendingImage, setPendingImage] = useState<number | null>(null);
  const [showPad, setShowPad] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [hist, setHist] = useState<{ past: Item[][]; present: Item[]; future: Item[][] }>({ past: [], present: [], future: [] });
  const [draft, setDraft] = useState<Item[] | null>(null);
  const items = draft ?? hist.present;
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const fileInput = useRef<HTMLInputElement>(null);

  const commit = useCallback((next: Item[]) => setHist((h) => ({ past: [...h.past, h.present].slice(-100), present: next, future: [] })), []);
  const undo = () => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] } : h));
  const redo = () => setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h));

  // load document
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(null); setPageNo(0); setHist({ past: [], present: [], future: [] });
    openPdf(file).then((d) => !cancelled && setDoc(d)).catch(() => !cancelled && setError('This PDF could not be opened. It may be encrypted or damaged.'));
    return () => { cancelled = true; };
  }, [file]);
  useEffect(() => () => images.forEach((i) => URL.revokeObjectURL(i.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // container size for fit modes
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: Math.max(200, el.clientWidth - 32), h: Math.max(360, window.innerHeight * 0.7) }));
    ro.observe(el); return () => ro.disconnect();
    // The container only exists once the document has loaded, so (re)attach then.
  }, [doc]);

  // report payload upward
  useEffect(() => { onChange(buildPayload(mode, hist.present, images.map((i) => i.file), dpi, { text: searchText, caseSensitive })); }, [hist.present, images, dpi, mode, searchText, caseSensitive]); // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard: delete selected, undo/redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); commit(hist.present.filter((i) => i.id !== selected)); setSelected(null); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape') { setSelected(null); setTool('select'); setEditing(null); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });

  const total = doc?.numPages ?? 0;
  const pageItems = useMemo(() => items.filter((i) => i.page === pageNo), [items, pageNo]);

  const tools: { id: Tool; label: string; icon: typeof Type; modes: Mode[] }[] = [
    { id: 'select', label: 'Select / move', icon: MousePointer2, modes: ['edit', 'sign', 'redact'] },
    { id: 'redact', label: 'Redact area', icon: EyeOff, modes: ['redact'] },
    { id: 'text', label: 'Text', icon: Type, modes: ['edit', 'sign'] },
    { id: 'rect', label: 'Rectangle', icon: Square, modes: ['edit'] },
    { id: 'ellipse', label: 'Ellipse', icon: Circle, modes: ['edit'] },
    { id: 'line', label: 'Line', icon: Minus, modes: ['edit'] },
    { id: 'highlight', label: 'Highlight', icon: Highlighter, modes: ['edit'] },
    { id: 'draw', label: 'Freehand', icon: PenLine, modes: ['edit'] },
  ];

  const addImage = (f: File) => {
    const url = URL.createObjectURL(f);
    setImages((cur) => { setPendingImage(cur.length); return [...cur, { file: f, url }]; });
    setTool('image');
  };

  const selectedItem = items.find((i) => i.id === selected);
  /** Edit properties of the selected annotation (commits to history) and the defaults for new ones. */
  const setProp = (patch: Partial<Defaults>) => {
    setDefaults((d) => ({ ...d, ...patch }));
    if (!selectedItem || isRedaction(selectedItem)) return;
    const a = selectedItem as A; const next: Record<string, unknown> = {};
    if ('color' in a && patch.color) next.color = patch.color;
    if (a.type === 'highlight' && patch.highlight) next.color = patch.highlight;
    if ('strokeWidth' in a && patch.strokeWidth !== undefined) next.strokeWidth = patch.strokeWidth;
    if ('opacity' in a && patch.opacity !== undefined) next.opacity = patch.opacity;
    if ((a.type === 'rect' || a.type === 'ellipse')) { if (patch.stroke) next.stroke = patch.stroke; if ('fill' in patch) next.fill = patch.fill; }
    if (a.type === 'text') { if (patch.fontSize) next.fontSize = patch.fontSize; if (patch.font) next.font = patch.font; }
    if (Object.keys(next).length) commit(hist.present.map((i) => (i.id === a.id ? ({ ...a, ...next } as A) : i)));
  };

  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (!doc) return <p className="text-sm text-slate-500" role="status">Loading document…</p>;

  const visibleTools = tools.filter((t) => t.modes.includes(mode));
  return (
    <div className="space-y-3">
      {mode === 'sign' && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          This places a <b>visual signature image</b>. It is not a certificate-based digital signature and provides no cryptographic proof of identity or integrity.</p>
      )}
      {mode === 'redact' && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Draw boxes over content to remove. Pages with boxes are converted to images with the areas burned in, so the covered content is deleted. Text on those pages will no longer be selectable.</p>
      )}
      {mode === 'edit' && <p className="text-xs text-slate-500">This editor adds new content on top of the pages. It does not change text that is already in the PDF.</p>}

      {/* toolbar */}
      <div role="toolbar" aria-label="Editing tools" className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-2">
        {visibleTools.map((t) => (
          <Button key={t.id} size="sm" variant={tool === t.id ? 'primary' : 'ghost'} aria-label={t.label} aria-pressed={tool === t.id} title={t.label} disabled={disabled} onClick={() => { setTool(t.id); if (t.id !== 'select') setSelected(null); }}><t.icon className="h-4 w-4" /></Button>
        ))}
        {mode !== 'redact' && (
          <>
            <Button size="sm" variant={tool === 'image' ? 'primary' : 'ghost'} aria-label="Add image" title="Add image" disabled={disabled} onClick={() => fileInput.current?.click()}><ImagePlus className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" aria-label="Draw signature" title="Draw signature" disabled={disabled} onClick={() => setShowPad(true)}><Signature className="h-4 w-4" /></Button>
            <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Choose an image to place" accept="image/png,image/jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) addImage(f); e.target.value = ''; }} />
          </>
        )}
        <span className="mx-1 h-6 w-px bg-slate-300" aria-hidden="true" />
        <Button size="sm" variant="ghost" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={disabled || !hist.past.length} onClick={undo}><Undo2 className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={disabled || !hist.future.length} onClick={redo}><Redo2 className="h-4 w-4" /></Button>
        <Button size="sm" variant="danger" aria-label="Delete selected" title="Delete selected (Del)" disabled={disabled || !selected} onClick={() => { commit(hist.present.filter((i) => i.id !== selected)); setSelected(null); }}><Trash2 className="h-4 w-4" /></Button>
        <span className="mx-1 h-6 w-px bg-slate-300" aria-hidden="true" />
        <Button size="sm" variant="ghost" aria-label="Zoom out" disabled={disabled} onClick={() => setZoom((z) => Math.max(0.25, (typeof z === 'number' ? z : 1) - 0.25))}><ZoomOut className="h-4 w-4" /></Button>
        <span className="min-w-12 text-center text-xs text-slate-600" aria-live="polite">{typeof zoom === 'number' ? `${Math.round(zoom * 100)}%` : zoom === 'width' ? 'Fit W' : 'Fit P'}</span>
        <Button size="sm" variant="ghost" aria-label="Zoom in" disabled={disabled} onClick={() => setZoom((z) => Math.min(4, (typeof z === 'number' ? z : 1) + 0.25))}><ZoomIn className="h-4 w-4" /></Button>
        <Button size="sm" variant={zoom === 'width' ? 'secondary' : 'ghost'} aria-label="Fit to width" title="Fit to width" onClick={() => setZoom('width')}><MoveHorizontal className="h-4 w-4" /></Button>
        <Button size="sm" variant={zoom === 'page' ? 'secondary' : 'ghost'} aria-label="Fit to page" title="Fit to page" onClick={() => setZoom('page')}><Maximize className="h-4 w-4" /></Button>
        <span className="ml-auto flex items-center gap-1 text-sm">
          <Button size="sm" variant="ghost" aria-label="Previous page" disabled={pageNo === 0} onClick={() => setPageNo((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <label className="flex items-center gap-1"><span className="sr-only">Page number</span>
            <input className="w-14 rounded-lg border border-slate-300 px-2 py-1 text-center text-sm" type="number" min={1} max={total} value={pageNo + 1} onChange={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= total) setPageNo(v - 1); }} /></label>
          <span className="text-slate-500">/ {total}</span>
          <Button size="sm" variant="ghost" aria-label="Next page" disabled={pageNo >= total - 1} onClick={() => setPageNo((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </span>
      </div>

      {/* properties */}
      {mode !== 'redact' && (
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-4 lg:grid-cols-6">
          <Field label="Colour"><TextInput type="color" className="h-9 p-1" value={defaults.color} onChange={(e) => setProp({ color: e.target.value, stroke: e.target.value })} /></Field>
          <Field label="Line width"><Select value={defaults.strokeWidth} onChange={(e) => setProp({ strokeWidth: Number(e.target.value) })}>{[1, 2, 3, 5, 8].map((w) => <option key={w} value={w}>{w} pt</option>)}</Select></Field>
          <Field label={`Opacity ${Math.round(defaults.opacity * 100)}%`}><input className="w-full" type="range" min={0.1} max={1} step={0.05} value={defaults.opacity} onChange={(e) => setProp({ opacity: Number(e.target.value) })} /></Field>
          <Field label="Fill"><label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={defaults.fill !== null} onChange={(e) => setProp({ fill: e.target.checked ? defaults.color : null })} />Fill shapes</label></Field>
          <Field label="Font size"><TextInput type="number" min={6} max={96} value={defaults.fontSize} onChange={(e) => setProp({ fontSize: Number(e.target.value) })} /></Field>
          <Field label="Font"><Select value={defaults.font} onChange={(e) => setProp({ font: e.target.value as Defaults['font'] })}><option value="helvetica">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></Select></Field>
        </div>
      )}
      {mode === 'redact' && (
        <>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Find and redact text (optional)" hint="One word or phrase per line. Every match in the PDF's text layer is covered, including partial matches inside a word. Scanned images are not searched.">
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" rows={3} maxLength={5000} value={searchText} disabled={disabled} onChange={(e) => setSearchText(e.target.value)} placeholder={'Jane Doe\n555-0100'} />
          </Field>
          <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={caseSensitive} disabled={disabled} onChange={(e) => setCaseSensitive(e.target.checked)} />Match case</label>
        </div>
        <div className="max-w-xs"><Field label="Resolution of redacted pages (DPI)" hint="Higher is sharper but makes a larger file."><Select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}><option value={100}>100</option><option value={150}>150</option><option value={200}>200</option><option value={300}>300</option></Select></Field></div>
        </>
      )}

      <div className="flex gap-3">
        <Thumbnails doc={doc} current={pageNo} onPick={setPageNo} items={items} />
        <div ref={containerRef} role="region" aria-label="Page canvas" tabIndex={0} className="min-w-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-4" style={{ maxHeight: '75vh' }}>
          <PageView
            key={pageNo} doc={doc} pageNo={pageNo} zoom={zoom} box={box} mode={mode} tool={tool} items={items} pageItems={pageItems} images={images}
            defaults={defaults} pendingImage={pendingImage} selected={selected} editing={editing} disabled={disabled}
            setSelected={setSelected} setEditing={setEditing} setDraft={setDraft} commit={commit} base={hist.present} setTool={setTool}
          />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {mode === 'redact' ? 'Drag on the page to mark areas.' : 'Pick a tool and drag on the page. Select an item to move it, drag its corner to resize, press Delete to remove it.'}
        {' '}{items.length} item{items.length === 1 ? '' : 's'} total.
      </p>
      {showPad && <SignaturePad onCancel={() => setShowPad(false)} onDone={(f) => { setShowPad(false); addImage(f); }} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
interface PVProps {
  doc: PDFDocumentProxy; pageNo: number; zoom: Zoom; box: { w: number; h: number }; mode: Mode; tool: Tool;
  items: Item[]; pageItems: Item[]; base: Item[]; images: { file: File; url: string }[]; defaults: Defaults;
  pendingImage: number | null; selected: string | null; editing: string | null; disabled?: boolean;
  setSelected: (id: string | null) => void; setEditing: (id: string | null) => void;
  setDraft: (d: Item[] | null) => void; commit: (n: Item[]) => void; setTool: (t: Tool) => void;
}

/** `item` always holds the in-progress item so handlers never depend on possibly stale React state. */
type Drag =
  | { kind: 'create'; start: [number, number]; item: Item }
  | { kind: 'move'; start: [number, number]; orig: Item; captured: boolean }
  | { kind: 'resize'; orig: Item }
  | { kind: 'draw'; pts: [number, number][]; item: A };

function PageView(p: PVProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const [pts, setPts] = useState<{ w: number; h: number } | null>(null); // page size in PDF points (as displayed)
  const drag = useRef<Drag | null>(null);

  const scale = useMemo(() => {
    if (!pts) return 1;
    if (typeof p.zoom === 'number') return p.zoom * (96 / 72);
    const fw = p.box.w / pts.w, fp = Math.min(p.box.w / pts.w, p.box.h / pts.h);
    return Math.max(0.2, p.zoom === 'width' ? fw : fp);
  }, [pts, p.zoom, p.box]);

  useEffect(() => {
    let dead = false;
    void p.doc.getPage(p.pageNo + 1).then((page) => {
      if (dead) return;
      const v1 = page.getViewport({ scale: 1 });
      setPts({ w: v1.width, h: v1.height });
    });
    return () => { dead = true; };
  }, [p.doc, p.pageNo]);

  useEffect(() => {
    if (!pts) return;
    let task = null as { cancel(): void; promise: Promise<unknown> } | null; let dead = false;
    void p.doc.getPage(p.pageNo + 1).then((page) => {
      if (dead || !canvas.current) return;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      task.promise.catch(() => undefined);
    });
    return () => { dead = true; task?.cancel(); };
  }, [p.doc, p.pageNo, scale, pts]);

  if (!pts) return <p className="text-sm text-slate-500">Loading page…</p>;
  const W = pts.w * scale, H = pts.h * scale;
  const pxPerPt = scale;

  const frac = (e: React.PointerEvent): [number, number] => {
    const r = overlay.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const onDown = (e: React.PointerEvent) => {
    if (p.disabled || e.button !== 0) return;
    // A click while a text box is being edited only finishes the edit (its blur handler commits);
    // starting a new item here would race with that commit and drop the typed text.
    if (p.editing) { (document.activeElement as HTMLElement | null)?.blur(); return; }
    const f = frac(e);
    const d = p.defaults;
    overlay.current!.setPointerCapture(e.pointerId);
    if (p.tool === 'select') { p.setSelected(null); p.setEditing(null); return; }
    const id = uid();
    p.setSelected(null);
    if (p.tool === 'draw') {
      const item = { id, type: 'draw', page: p.pageNo, points: simplify([f]), color: d.color, strokeWidth: d.strokeWidth, opacity: d.opacity } as A;
      drag.current = { kind: 'draw', pts: [f], item };
      p.setDraft([...p.base, item]);
      return;
    }
    const r = normRect(f, f);
    let item: Item;
    switch (p.tool) {
      case 'redact': item = { id, page: p.pageNo, ...r } as R; break;
      case 'rect': case 'ellipse': item = { id, type: p.tool, page: p.pageNo, ...r, stroke: d.stroke, fill: d.fill, strokeWidth: d.strokeWidth, opacity: d.opacity } as A; break;
      case 'highlight': item = { id, type: 'highlight', page: p.pageNo, ...r, color: d.highlight, opacity: 0.45 } as A; break;
      case 'line': item = { id, type: 'line', page: p.pageNo, x1: f[0], y1: f[1], x2: f[0], y2: f[1], color: d.color, strokeWidth: d.strokeWidth, opacity: d.opacity } as A; break;
      case 'text': item = { id, type: 'text', page: p.pageNo, ...r, text: ' ', fontSize: d.fontSize, color: d.color, font: d.font } as A; break;
      case 'image': item = { id, type: 'image', page: p.pageNo, ...r, imageIndex: p.pendingImage ?? 0, opacity: 1 } as A; break;
      default: return;
    }
    drag.current = { kind: 'create', start: f, item };
    p.setDraft([...p.base, item]);
  };

  const grow = (item: Item, start: [number, number], f: [number, number]): Item =>
    !isRedaction(item) && item.type === 'line' ? ({ ...item, x2: f[0], y2: f[1] } as A) : ({ ...item, ...normRect(start, f) } as Item);

  const onMove = (e: React.PointerEvent) => {
    const dr = drag.current; if (!dr) return;
    const f = frac(e);
    if (dr.kind === 'draw') {
      dr.pts.push(f);
      dr.item = { ...dr.item, points: simplify(dr.pts, 0.0015) } as A;
      p.setDraft([...p.base, dr.item]);
    } else if (dr.kind === 'create') {
      dr.item = grow(dr.item, dr.start, f);
      p.setDraft([...p.base, dr.item]);
    } else if (dr.kind === 'move') {
      if (!dr.captured && Math.hypot(f[0] - dr.start[0], f[1] - dr.start[1]) > 0.004) { overlay.current!.setPointerCapture(e.pointerId); dr.captured = true; }
      p.setDraft(p.base.map((i) => (i.id === dr.orig.id ? move(dr.orig, f[0] - dr.start[0], f[1] - dr.start[1]) : i)));
    } else {
      p.setDraft(p.base.map((i) => (i.id === dr.orig.id ? resizeTo(dr.orig, f[0], f[1]) : i)));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const dr = drag.current; drag.current = null;
    if (!dr) return;
    const f = frac(e);
    let next: Item[];
    if (dr.kind === 'draw') {
      next = [...p.base, { ...dr.item, points: simplify(dr.pts, 0.0015) } as A];
    } else if (dr.kind === 'create') {
      let made = grow(dr.item, dr.start, f);
      const b = bounds(made);
      const isText = !isRedaction(made) && made.type === 'text';
      const isImage = !isRedaction(made) && made.type === 'image';
      const tooSmall = hasBox(made) ? b.w < 0.01 && b.h < 0.01 : b.w < 0.005 && b.h < 0.005;
      if (tooSmall && !isText && !isImage) { p.setDraft(null); return; }
      // A plain click places a text box / image with a sensible default size.
      if (tooSmall && hasBox(made)) made = { ...made, w: Math.min(isText ? 0.5 : 0.25, 1 - made.x), h: Math.min(isText ? 0.08 : 0.12, 1 - made.y) } as Item;
      next = [...p.base, made];
      p.setSelected(made.id);
      if (isText) {
        // A text box is ONE history step, committed when it has content (see the textarea's onBlur).
        // Committing the empty placeholder here would make Undo leave an invisible blank item behind.
        p.setEditing(made.id);
        p.setDraft(next);
        return;
      }
      if (p.tool !== 'redact' && p.tool !== 'draw') p.setTool('select');
    } else {
      const apply = (i: Item) => (dr.kind === 'move' ? move(dr.orig, f[0] - dr.start[0], f[1] - dr.start[1]) : resizeTo(dr.orig, f[0], f[1]));
      next = p.base.map((i) => (i.id === dr.orig.id ? apply(i) : i));
      // A plain click (no movement) must not add an undo step.
      if (JSON.stringify(next) === JSON.stringify(p.base)) { p.setDraft(null); return; }
    }
    p.setDraft(null);
    p.commit(next);
  };

  const startMove = (e: React.PointerEvent, it: Item) => {
    if (p.tool !== 'select' || p.disabled) return;
    e.stopPropagation();
    // Do NOT capture the pointer yet: capturing on pointer-down retargets the following click/dblclick
    // to the <svg>, which would break double-click-to-edit. We capture once the user really drags.
    p.setSelected(it.id); p.setEditing(null);
    drag.current = { kind: 'move', start: frac(e), orig: it, captured: false };
  };
  const startResize = (e: React.PointerEvent, it: Item) => {
    e.stopPropagation();
    overlay.current!.setPointerCapture(e.pointerId);
    drag.current = { kind: 'resize', orig: it };
  };

  const editingItem = p.editing ? (p.items.find((i) => i.id === p.editing) as (A & { type: 'text' }) | undefined) : undefined;

  return (
    <div className="relative mx-auto bg-white shadow" style={{ width: W, height: H }}>
      <canvas ref={canvas} style={{ width: W, height: H }} className="absolute inset-0" aria-label={`Page ${p.pageNo + 1}`} role="img" />
      <svg ref={overlay} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={cn('absolute inset-0 touch-none', p.tool !== 'select' ? 'cursor-crosshair' : 'cursor-default')}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; p.setDraft(null); }}>
        {p.pageItems.map((it) => (
          <ItemShape key={it.id} it={it} W={W} H={H} pxPerPt={pxPerPt} images={p.images} selected={p.selected === it.id}
            hidden={p.editing === it.id} onDown={(e) => startMove(e, it)} onResize={(e) => startResize(e, it)} onEdit={() => { p.setSelected(it.id); p.setEditing(it.id); }} interactive={p.tool === 'select' && !p.disabled} />
        ))}
      </svg>
      {editingItem && (
        <textarea
          autoFocus aria-label="Annotation text" value={editingItem.text === ' ' ? '' : editingItem.text}
          className="absolute resize-none overflow-hidden border border-dashed border-brand-500 bg-white/80 p-0 leading-[1.2] outline-none"
          style={{ left: editingItem.x * W, top: editingItem.y * H, width: editingItem.w * W, height: Math.max(editingItem.h * H, editingItem.fontSize * pxPerPt * 1.4), fontSize: editingItem.fontSize * pxPerPt, color: editingItem.color, fontFamily: FONT_CSS[editingItem.font] }}
          onChange={(e) => {
            // grow with content so wrapped lines stay visible
            e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`;
            p.setDraft(p.items.map((i) => (i.id === editingItem.id ? ({ ...editingItem, text: e.target.value || ' ' } as A) : i)));
          }}
          onBlur={(e) => {
            const text = e.target.value.trim();
            const h = Math.min(1 - editingItem.y, Math.max(editingItem.h, e.target.scrollHeight / H));
            const others = p.items.filter((i) => i.id !== editingItem.id);
            p.setDraft(null);
            const existing = p.base.some((i) => i.id === editingItem.id);
            if (!text) { if (existing) p.commit(others); p.setSelected(null); } // empty text: discard (or delete when editing an existing box)
            else p.commit(existing ? p.base.map((i) => (i.id === editingItem.id ? ({ ...editingItem, text, h } as A) : i)) : [...others, { ...editingItem, text, h } as A]);
            p.setEditing(null);
          }}
        />
      )}
    </div>
  );
}

interface ShapeProps { it: Item; W: number; H: number; pxPerPt: number; images: { url: string }[]; selected: boolean; hidden: boolean; interactive: boolean; onDown: (e: React.PointerEvent) => void; onResize: (e: React.PointerEvent) => void; onEdit: () => void }

function ItemShape({ it, W, H, pxPerPt, images, selected, hidden, interactive, onDown, onResize, onEdit }: ShapeProps) {
  const common = { onPointerDown: onDown, style: { cursor: interactive ? 'move' : undefined, pointerEvents: interactive ? ('all' as const) : ('none' as const) } };
  let body: React.ReactNode = null;
  const b = bounds(it);
  if (isRedaction(it)) {
    body = <rect x={b.x * W} y={b.y * H} width={b.w * W} height={b.h * H} fill="rgba(0,0,0,0.85)" stroke="#dc2626" strokeWidth={2} strokeDasharray="6 3" {...common} />;
  } else {
    switch (it.type) {
      case 'rect': body = <rect x={it.x * W} y={it.y * H} width={it.w * W} height={it.h * H} fill={it.fill ?? 'transparent'} fillOpacity={it.fill ? it.opacity : 1} stroke={it.stroke ?? 'none'} strokeOpacity={it.opacity} strokeWidth={it.strokeWidth * pxPerPt} {...common} />; break;
      case 'ellipse': body = <ellipse cx={(it.x + it.w / 2) * W} cy={(it.y + it.h / 2) * H} rx={(it.w * W) / 2} ry={(it.h * H) / 2} fill={it.fill ?? 'transparent'} fillOpacity={it.fill ? it.opacity : 1} stroke={it.stroke ?? 'none'} strokeOpacity={it.opacity} strokeWidth={it.strokeWidth * pxPerPt} {...common} />; break;
      case 'highlight': body = <rect x={it.x * W} y={it.y * H} width={it.w * W} height={it.h * H} fill={it.color} fillOpacity={it.opacity} style={{ mixBlendMode: 'multiply', ...common.style }} onPointerDown={onDown} />; break;
      case 'line': body = <line x1={it.x1 * W} y1={it.y1 * H} x2={it.x2 * W} y2={it.y2 * H} stroke={it.color} strokeOpacity={it.opacity} strokeWidth={Math.max(it.strokeWidth * pxPerPt, interactive ? 8 : 0)} strokeLinecap="round" {...common} />; break;
      case 'draw': body = <polyline points={it.points.map(([x, y]) => `${x * W},${y * H}`).join(' ')} fill="none" stroke={it.color} strokeOpacity={it.opacity} strokeWidth={it.strokeWidth * pxPerPt} strokeLinecap="round" strokeLinejoin="round" {...common} />; break;
      case 'image': body = <image href={images[it.imageIndex]?.url} x={it.x * W} y={it.y * H} width={it.w * W} height={it.h * H} preserveAspectRatio="none" opacity={it.opacity} {...common} />; break;
      case 'text':
        body = hidden ? null : (
          <foreignObject x={it.x * W} y={it.y * H} width={it.w * W} height={Math.max(it.h * H, it.fontSize * pxPerPt * 1.4)} onDoubleClick={interactive ? onEdit : undefined} {...common}>
            <div style={{ fontSize: it.fontSize * pxPerPt, lineHeight: 1.2, color: it.color, fontFamily: FONT_CSS[it.font], whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: '100%', height: '100%' }}>{it.text}</div>
          </foreignObject>
        );
        break;
    }
  }
  return (
    <g>
      {body}
      {selected && (
        <>
          <rect x={b.x * W - 3} y={b.y * H - 3} width={b.w * W + 6} height={b.h * H + 6} fill="none" stroke="#4f46e5" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
          {hasBox(it) && <rect x={(b.x + b.w) * W - 5} y={(b.y + b.h) * H - 5} width={10} height={10} fill="#4f46e5" style={{ cursor: 'nwse-resize' }} onPointerDown={onResize} />}
        </>
      )}
    </g>
  );
}

// ------------------------------------------------------------------------------------------------
function Thumbnails({ doc, current, onPick, items }: { doc: PDFDocumentProxy; current: number; onPick: (i: number) => void; items: Item[] }) {
  return (
    <ol aria-label="Page thumbnails" className="hidden max-h-[75vh] w-28 shrink-0 space-y-2 overflow-y-auto pr-1 md:block">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <li key={i}>
          <button type="button" onClick={() => onPick(i)} aria-label={`Go to page ${i + 1}`} aria-current={i === current ? 'page' : undefined}
            className={cn('relative block w-full rounded-lg border-2 bg-white p-1', i === current ? 'border-brand-600' : 'border-slate-200 hover:border-slate-400')}>
            <Thumb doc={doc} index={i} />
            <span className="mt-1 block text-center text-[11px] text-slate-600">{i + 1}</span>
            {items.some((x) => x.page === i) && <span className="absolute right-1 top-1 rounded-full bg-brand-600 px-1.5 text-[10px] text-white">{items.filter((x) => x.page === i).length}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Thumb({ doc, index }: { doc: PDFDocumentProxy; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let done = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || done) return;
      done = true; io.disconnect();
      void doc.getPage(index + 1).then((page) => {
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 90 / base.width });
        el.width = Math.ceil(vp.width); el.height = Math.ceil(vp.height);
        return page.render({ canvasContext: el.getContext('2d')!, viewport: vp }).promise;
      }).catch(() => undefined);
    });
    io.observe(el); return () => io.disconnect();
  }, [doc, index]);
  return <canvas ref={ref} className="mx-auto max-w-full" width={90} height={120} aria-hidden="true" />;
}
