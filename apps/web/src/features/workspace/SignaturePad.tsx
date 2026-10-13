import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Draw a signature with mouse/touch/pen; exports a tightly cropped transparent PNG. */
export function SignaturePad({ onDone, onCancel }: { onDone: (file: File) => void; onCancel: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 600, y: ((e.clientY - r.top) / r.height) * 220 };
  };
  const down = (e: React.PointerEvent) => {
    ref.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = pos(e); const ctx = ref.current!.getContext('2d')!;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y); ctx.stroke(); setEmpty(false);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const { x, y } = pos(e); const ctx = ref.current!.getContext('2d')!;
    ctx.lineTo(x, y); ctx.stroke();
  };
  const clear = () => { ref.current!.getContext('2d')!.clearRect(0, 0, 600, 220); setEmpty(true); };

  const use = () => {
    const c = ref.current!; const ctx = c.getContext('2d')!;
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3]! > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
    const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    out.toBlob((b) => b && onDone(new File([b], 'signature.png', { type: 'image/png' })), 'image/png');
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Draw your signature" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">Draw your signature</h2>
        <p className="mt-1 text-xs text-slate-500">This creates a visual signature image only, not a certificate-based digital signature.</p>
        <canvas ref={ref} width={600} height={220} className="mt-3 w-full touch-none rounded-xl border border-slate-300 bg-white" aria-label="Signature drawing area" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={clear} disabled={empty}>Clear</Button>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={use} disabled={empty}>Use signature</Button>
        </div>
      </div>
    </div>
  );
}
