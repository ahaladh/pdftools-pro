import { useEffect, useRef, useState } from 'react';
import { Copy, RotateCw, Trash2, ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openPdf } from './pdfjs';
import { cn } from '@/lib/utils';

export interface OrganizerPage { key: string; src: number; rotation: 0 | 90 | 180 | 270 }
interface Props { file: File; onChange: (order: string, rotations: Record<string, 0 | 90 | 180 | 270>, count: number) => void; disabled?: boolean }

function Thumb({ file, pageNo, rotation }: { file: File; pageNo: number; rotation: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { void renderThumb(file, pageNo, ref.current).catch(() => undefined); }, [file, pageNo]);
  return <canvas ref={ref} className="max-h-40 max-w-full rounded border border-slate-200 bg-white shadow-sm transition-transform" style={{ transform: `rotate(${rotation}deg)` }} aria-label={`Page ${pageNo} preview`} />;
}

// Render each source page once and blit the bitmap to every canvas that needs it (duplicates are cheap).
const bitmaps = new WeakMap<File, Map<number, Promise<HTMLCanvasElement>>>();
async function renderThumb(file: File, pageNo: number, target: HTMLCanvasElement | null) {
  let m = bitmaps.get(file); if (!m) { m = new Map(); bitmaps.set(file, m); }
  let p = m.get(pageNo);
  if (!p) {
    p = (async () => {
      const doc = await openPdfCached(file);
      const page = await doc.getPage(pageNo);
      const vp = page.getViewport({ scale: 0.35 });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
      return c;
    })();
    m.set(pageNo, p);
  }
  const src = await p;
  if (target) { target.width = src.width; target.height = src.height; target.getContext('2d')!.drawImage(src, 0, 0); }
}
const docs = new WeakMap<File, ReturnType<typeof openPdf>>();
function openPdfCached(f: File) { let d = docs.get(f); if (!d) { d = openPdf(f); docs.set(f, d); } return d; }

/** Visual page manager: reorder (drag or buttons), rotate, duplicate and delete pages. */
export function PageOrganizer({ file, onChange, disabled }: Props) {
  const [pages, setPages] = useState<OrganizerPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const dragFrom = useRef<number | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    openPdfCached(file).then((d) => {
      if (cancelled) return;
      setPages(Array.from({ length: d.numPages }, (_, i) => ({ key: `p${seq.current++}`, src: i + 1, rotation: 0 })));
    }).catch(() => !cancelled && setError('This PDF could not be previewed. It may be encrypted or damaged.'));
    return () => { cancelled = true; };
  }, [file]);

  useEffect(() => {
    const rot: Record<string, 0 | 90 | 180 | 270> = {};
    pages.forEach((p, i) => { if (p.rotation) rot[String(i + 1)] = p.rotation; });
    onChange(pages.map((p) => p.src).join(','), rot, pages.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  const move = (from: number, to: number) => setPages((ps) => {
    if (to < 0 || to >= ps.length) return ps;
    const n = [...ps]; const [it] = n.splice(from, 1); n.splice(to, 0, it!); return n;
  });
  const rotate = (i: number) => setPages((ps) => ps.map((p, k) => k === i ? { ...p, rotation: ((p.rotation + 90) % 360) as OrganizerPage['rotation'] } : p));
  const dup = (i: number) => setPages((ps) => { const n = [...ps]; n.splice(i + 1, 0, { ...ps[i]!, key: `p${seq.current++}` }); return n; });
  const reverse = () => setPages((ps) => [...ps].reverse());
  const del = (i: number) => setPages((ps) => ps.filter((_, k) => k !== i));

  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (!pages.length) return <p className="text-sm text-slate-500">Loading pages…</p>;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-slate-600">{pages.length} page{pages.length === 1 ? '' : 's'} in the result. Drag to reorder; deleted pages are left out.</p>
        <Button size="sm" variant="secondary" disabled={disabled || pages.length < 2} onClick={reverse}>Reverse order</Button>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {pages.map((p, i) => (
          <li key={p.key} draggable={!disabled}
            onDragStart={() => { dragFrom.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null; }}
            className={cn('flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2')}>
            <div className="flex h-44 w-full items-center justify-center overflow-hidden"><Thumb file={file} pageNo={p.src} rotation={p.rotation} /></div>
            <span className="text-xs text-slate-600">Position {i + 1} · source p.{p.src}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={disabled || i === 0} aria-label={`Move position ${i + 1} earlier`} onClick={() => move(i, i - 1)}><ArrowLeft className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Rotate position ${i + 1}`} onClick={() => rotate(i)}><RotateCw className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Duplicate position ${i + 1}`} onClick={() => dup(i)}><Copy className="h-4 w-4" /></Button>
              <Button size="sm" variant="danger" disabled={disabled || pages.length === 1} aria-label={`Delete position ${i + 1}`} onClick={() => del(i)}><Trash2 className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" disabled={disabled || i === pages.length - 1} aria-label={`Move position ${i + 1} later`} onClick={() => move(i, i + 1)}><ArrowRight className="h-4 w-4" /></Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
