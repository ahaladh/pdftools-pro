import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Maximize, MoveHorizontal, Search, ZoomIn, ZoomOut } from 'lucide-react';
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { openPdf } from '@/features/tools/pdfjs';
import { buildPageText, findMatches, locate, MAX_HITS, sameText, type Hit, type PageText, type TextPiece } from './search';

type Zoom = 'width' | 'page' | number;
interface Rect { left: number; top: number; width: number; height: number }
interface Cached { pieces: TextPiece[]; page: PageText }

/** A read-only PDF viewer: zoom, fit, thumbnails, selectable text, and search across the whole document. Nothing is uploaded. */
export function Viewer({ file }: { file: File }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [protectedFile, setProtectedFile] = useState(false);
  const [pageNo, setPageNo] = useState(0);
  const [zoom, setZoom] = useState<Zoom>('width');
  const [box, setBox] = useState({ w: 800, h: 600 });
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [current, setCurrent] = useState(0);
  const [searching, setSearching] = useState<{ done: number; total: number } | null>(null);
  const [capped, setCapped] = useState(false);
  const texts = useRef(new Map<number, Cached>());
  const hitPages = useMemo(() => new Set(hits.map((h) => h.page)), [hits]);

  useEffect(() => {
    let dead = false;
    setDoc(null); setError(null); setProtectedFile(false); setPageNo(0); setHits([]); texts.current = new Map();
    openPdf(file).then((d) => !dead && setDoc(d)).catch((e: unknown) => {
      if (dead) return;
      if ((e as { name?: string })?.name === 'PasswordException') setProtectedFile(true);
      else setError('This PDF could not be opened. It may be damaged.');
    });
    return () => { dead = true; };
  }, [file]);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: Math.max(200, el.clientWidth - 32), h: Math.max(360, window.innerHeight * 0.7) }));
    ro.observe(el); return () => ro.disconnect();
  }, [doc]);

  const textOf = useCallback(async (d: PDFDocumentProxy, n: number): Promise<Cached> => {
    const hit = texts.current.get(n);
    if (hit) return hit;
    const content = await (await d.getPage(n + 1)).getTextContent();
    const pieces = content.items.filter((i): i is typeof i & { str: string } => 'str' in i).map((i) => ({ str: i.str, hasEOL: (i as { hasEOL?: boolean }).hasEOL }));
    const c = { pieces, page: buildPageText(pieces) };
    texts.current.set(n, c);
    return c;
  }, []);

  // Search the whole document (after a short pause while typing). Text is read page by page and kept, so repeated searches are quick.
  useEffect(() => {
    if (!doc) return;
    const q = query.trim();
    if (!q) { setHits([]); setSearching(null); setCapped(false); return; }
    let dead = false;
    const t = setTimeout(async () => {
      const found: Hit[] = []; let over = false;
      for (let n = 0; n < doc.numPages && !over; n++) {
        if (dead) return;
        const { page } = await textOf(doc, n);
        for (const m of findMatches(page.text, q, matchCase)) { if (found.length >= MAX_HITS) { over = true; break; } found.push({ page: n, ...m }); }
        if (n % 5 === 0) setSearching({ done: n + 1, total: doc.numPages });
      }
      if (dead) return;
      setHits(found); setCapped(over); setSearching(null);
      const first = found.findIndex((h) => h.page >= pageNo);
      setCurrent(first >= 0 ? first : 0);
      if (found.length && !found.some((h) => h.page === pageNo)) setPageNo(found[first >= 0 ? first : 0]!.page);
    }, 250);
    return () => { dead = true; clearTimeout(t); };
    // `pageNo` is read only to start from where the reader is; changing page must not restart the search.
  }, [doc, query, matchCase, textOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (delta: number) => {
    if (!hits.length) return;
    const next = (current + delta + hits.length) % hits.length;
    setCurrent(next); setPageNo(hits[next]!.page);
  };

  if (protectedFile) return <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">This PDF is password-protected. Remove the password first with <Link className="underline" to="/unlock">Unlock PDF</Link> (you will need the password), then open it here.</p>;
  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (!doc) return <p role="status" className="text-sm text-slate-500">Opening the document…</p>;

  const total = doc.numPages;
  const status = !query.trim() ? '' : searching ? `Searching… page ${searching.done} of ${searching.total}` : hits.length === 0 ? 'No matches' : `Match ${current + 1} of ${hits.length}${capped ? '+' : ''}, on page ${hits[current]!.page + 1}${capped ? `. Showing the first ${MAX_HITS.toLocaleString()}` : ''}`;

  return (
    <div className="space-y-3">
      <div role="toolbar" aria-label="Viewer controls" className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-2">
        <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, (typeof z === 'number' ? z : 1) - 0.25))}><ZoomOut className="h-4 w-4" /></Button>
        <span className="min-w-12 text-center text-xs text-slate-600" aria-live="polite">{typeof zoom === 'number' ? `${Math.round(zoom * 100)}%` : zoom === 'width' ? 'Fit W' : 'Fit P'}</span>
        <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, (typeof z === 'number' ? z : 1) + 0.25))}><ZoomIn className="h-4 w-4" /></Button>
        <Button size="sm" variant={zoom === 'width' ? 'secondary' : 'ghost'} aria-label="Fit to width" aria-pressed={zoom === 'width'} onClick={() => setZoom('width')}><MoveHorizontal className="h-4 w-4" /></Button>
        <Button size="sm" variant={zoom === 'page' ? 'secondary' : 'ghost'} aria-label="Fit to page" aria-pressed={zoom === 'page'} onClick={() => setZoom('page')}><Maximize className="h-4 w-4" /></Button>
        <span className="mx-1 h-6 w-px bg-slate-300" aria-hidden="true" />
        <form className="flex items-center gap-1" role="search" aria-label="Find in document" onSubmit={(e) => { e.preventDefault(); go(1); }}>
          <label className="relative"><span className="sr-only">Find in document</span>
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in document" maxLength={200} autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); go(-1); } }}
              className="w-44 rounded-lg border border-slate-300 py-1 pl-7 pr-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" /></label>
          <Button type="button" size="sm" variant="ghost" aria-label="Previous match" disabled={!hits.length} onClick={() => go(-1)}><ChevronUp className="h-4 w-4" /></Button>
          <Button type="submit" size="sm" variant="ghost" aria-label="Next match" disabled={!hits.length}><ChevronDown className="h-4 w-4" /></Button>
          <label className="flex items-center gap-1 pl-1 text-xs text-slate-700"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />Match case</label>
        </form>
        <span className="ml-auto flex items-center gap-1 text-sm">
          <Button size="sm" variant="ghost" aria-label="Previous page" disabled={pageNo === 0} onClick={() => setPageNo((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <label className="flex items-center gap-1"><span className="sr-only">Page number</span>
            <input className="w-14 rounded-lg border border-slate-300 px-2 py-1 text-center text-sm" type="number" min={1} max={total} value={pageNo + 1} onChange={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= total) setPageNo(v - 1); }} /></label>
          <span className="text-slate-500">/ {total}</span>
          <Button size="sm" variant="ghost" aria-label="Next page" disabled={pageNo >= total - 1} onClick={() => setPageNo((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </span>
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-xs text-slate-700">{status}</p>

      <div className="flex gap-3">
        <Thumbnails doc={doc} current={pageNo} onPick={setPageNo} hitPages={hitPages} />
        <div ref={containerRef} role="region" aria-label="Document" tabIndex={0} className="min-w-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-4" style={{ maxHeight: '78vh' }}>
          <PageView key={pageNo} doc={doc} pageNo={pageNo} zoom={zoom} box={box} hits={hits} current={current} cached={texts.current.get(pageNo)} loadText={() => textOf(doc, pageNo)} />
        </div>
      </div>
    </div>
  );
}

function PageView({ doc, pageNo, zoom, box, hits, current, cached, loadText }: {
  doc: PDFDocumentProxy; pageNo: number; zoom: Zoom; box: { w: number; h: number }; hits: Hit[]; current: number; cached: Cached | undefined; loadText: () => Promise<Cached>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pageEl = useRef<HTMLDivElement>(null);
  const textEl = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null); // the page in PDF points, as displayed (rotation applied)
  const [laid, setLaid] = useState<{ divs: HTMLElement[]; strs: string[] } | null>(null);
  const [rects, setRects] = useState<{ global: number; rects: Rect[] }[]>([]);

  useEffect(() => {
    let dead = false;
    void doc.getPage(pageNo + 1).then((p) => { if (!dead) { const v = p.getViewport({ scale: 1 }); setSize({ w: v.width, h: v.height }); } });
    return () => { dead = true; };
  }, [doc, pageNo]);

  const scale = useMemo(() => {
    if (!size) return 1;
    if (typeof zoom === 'number') return zoom * (96 / 72);
    const byWidth = box.w / size.w, byPage = Math.min(box.w / size.w, box.h / size.h);
    return Math.max(0.2, zoom === 'width' ? byWidth : byPage);
  }, [size, zoom, box]);

  // paint the page, then its (invisible, selectable) text on top
  useEffect(() => {
    if (!size) return;
    let dead = false; let render: { cancel(): void; promise: Promise<unknown> } | null = null; let layer: TextLayer | null = null;
    setLaid(null);
    void doc.getPage(pageNo + 1).then(async (page) => {
      if (dead || !canvas.current || !textEl.current) return;
      const dpr = window.devicePixelRatio || 1;
      const painted = page.getViewport({ scale: scale * dpr });
      const c = canvas.current; c.width = Math.floor(painted.width); c.height = Math.floor(painted.height);
      render = page.render({ canvasContext: c.getContext('2d')!, viewport: painted });
      render.promise.catch(() => undefined);
      const t = textEl.current; t.replaceChildren(); t.style.setProperty('--scale-factor', String(scale));
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: t, viewport: page.getViewport({ scale }) });
      try { await layer.render(); } catch { return; }
      if (!dead) setLaid({ divs: layer.textDivs, strs: layer.textContentItemsStr });
    });
    return () => { dead = true; render?.cancel(); layer?.cancel(); };
  }, [doc, pageNo, scale, size]);

  // the matches on this page, in the text layer's own geometry: accurate for any font, zoom or page rotation
  useEffect(() => {
    let dead = false;
    void (async () => {
      const mine = hits.map((h, global) => ({ h, global })).filter((x) => x.h.page === pageNo);
      if (!laid || !pageEl.current || mine.length === 0) { if (!dead) setRects([]); return; }
      const text = cached ?? (await loadText());
      if (dead) return;
      // the text layer and our own reading of the page must describe the same pieces, or offsets would point at the wrong text
      if (!sameText(text.pieces, laid.strs)) { setRects([]); return; }
      const base = pageEl.current.getBoundingClientRect();
      const out = mine.map(({ h, global }) => {
        const rs: Rect[] = [];
        for (const part of locate(text.page, h)) {
          const node = laid.divs[part.item]?.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) continue;
          const range = document.createRange(); range.setStart(node, part.from); range.setEnd(node, part.to);
          for (const r of range.getClientRects()) if (r.width > 0) rs.push({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height });
        }
        return { global, rects: rs };
      });
      if (!dead) setRects(out);
    })();
    return () => { dead = true; };
  }, [laid, hits, pageNo, cached, loadText]);

  // bring the current match into view
  useEffect(() => {
    const el = pageEl.current?.querySelector('[data-current="true"]');
    if (el) (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [rects, current]);

  if (!size) return <p role="status" className="text-sm text-slate-500">Loading the page…</p>;
  const W = Math.round(size.w * scale), H = Math.round(size.h * scale);
  return (
    <div ref={pageEl} className="relative mx-auto bg-white shadow" style={{ width: W, height: H }}>
      <canvas ref={canvas} style={{ width: W, height: H }} className="absolute inset-0" role="img" aria-label={`Page ${pageNo + 1}`} />
      <div ref={textEl} className="textLayer" data-testid="text-layer" />
      <div className="pointer-events-none absolute inset-0" aria-hidden="true" data-testid="highlights">
        {rects.flatMap((m) => m.rects.map((r, i) => (
          <div key={`${m.global}-${i}`} data-hit={m.global} data-current={m.global === current} data-box={`${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`}
            className={cn('absolute rounded-[2px] mix-blend-multiply', m.global === current ? 'bg-orange-400/70 outline outline-2 outline-orange-500' : 'bg-yellow-300/70')}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
        )))}
      </div>
    </div>
  );
}

function Thumbnails({ doc, current, onPick, hitPages }: { doc: PDFDocumentProxy; current: number; onPick: (n: number) => void; hitPages: Set<number> }) {
  return (
    <ol aria-label="Page thumbnails" className="hidden max-h-[78vh] w-28 shrink-0 space-y-2 overflow-y-auto pr-1 md:block">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <li key={i}>
          <button type="button" onClick={() => onPick(i)} aria-label={`Go to page ${i + 1}${hitPages.has(i) ? ' (has matches)' : ''}`} aria-current={i === current ? 'page' : undefined}
            className={cn('relative block w-full rounded-lg border-2 bg-white p-1 text-center text-xs', i === current ? 'border-brand-500' : 'border-transparent hover:border-slate-300')}>
            <Thumb doc={doc} n={i} />
            <span className="mt-0.5 block text-slate-600">{i + 1}</span>
            {hitPages.has(i) && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-orange-400 ring-2 ring-white" aria-hidden="true" />}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Rendered only when scrolled into view, so a long document does not paint hundreds of thumbnails at once. */
function Thumb({ doc, n }: { doc: PDFDocumentProxy; n: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let dead = false;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      void doc.getPage(n + 1).then(async (page) => {
        const vp = page.getViewport({ scale: 0.3 });
        el.width = Math.ceil(vp.width); el.height = Math.ceil(vp.height);
        if (!dead) await page.render({ canvasContext: el.getContext('2d')!, viewport: vp }).promise.catch(() => undefined);
      });
    });
    io.observe(el);
    return () => { dead = true; io.disconnect(); };
  }, [doc, n]);
  return <canvas ref={ref} className="mx-auto max-w-full" width={90} height={120} aria-hidden="true" />;
}

