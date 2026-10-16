import { Check, Layers, ScanText, Scissors, TextCursorInput } from 'lucide-react';

/**
 * Decorative product illustration for the hero: a PDF page with an inline edit and floating tool chips.
 * Purely visual (aria-hidden), built from markup so it is crisp at any size and adds no image request.
 */
export function HeroPreview() {
  const bar = (w: string, tone = 'bg-slate-200') => <div className={`h-2 rounded-full ${tone}`} style={{ width: w }} />;
  return (
    <div className="relative mx-auto w-full max-w-md select-none" aria-hidden="true">
      <div className="absolute -inset-8 -z-10 rounded-[3rem] bg-gradient-to-br from-brand-500/30 via-violet-500/20 to-sky-400/20 blur-3xl" />

      {/* the page */}
      <div className="hero-float relative rounded-2xl bg-white p-6 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.6)] ring-1 ring-white/20">
        <div className="flex items-center gap-1.5 pb-4">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" /><span className="h-2.5 w-2.5 rounded-full bg-amber-400" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="ml-3 h-2 w-28 rounded-full bg-slate-100" />
        </div>
        <div className="space-y-3">
          <div className="h-3.5 w-2/3 rounded-full bg-slate-800" />
          {bar('100%')}{bar('92%')}
          <div className="relative my-1 rounded-md bg-amber-100 px-2 py-1.5 ring-2 ring-amber-400">
            <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-900">Invoice for Robert Chen<span className="hero-caret ml-0.5 inline-block h-3.5 w-px bg-amber-900" /></div>
            <span className="absolute -right-3 -top-3 grid h-6 w-6 place-items-center rounded-full bg-brand-600 text-white shadow-lg"><TextCursorInput className="h-3.5 w-3.5" /></span>
          </div>
          {bar('96%')}{bar('64%')}
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="col-span-2 h-24 rounded-xl bg-gradient-to-br from-sky-300 via-brand-400 to-violet-500" />
            <div className="space-y-2.5 pt-1">{bar('100%')}{bar('80%')}{bar('90%')}{bar('55%')}</div>
          </div>
          {bar('88%')}{bar('72%')}
        </div>
      </div>

      {/* floating tool chips */}
      <div className="hero-float-slow absolute -left-9 bottom-32 hidden items-center gap-2 rounded-xl bg-white/95 px-3 py-2 text-xs font-semibold text-slate-800 shadow-xl ring-1 ring-slate-900/5 sm:flex">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-amber-50 text-amber-700"><ScanText className="h-3.5 w-3.5" /></span>Scan to searchable
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      </div>
      <div className="hero-float-slower absolute -right-6 top-1/2 hidden items-center gap-2 rounded-xl bg-white/95 px-3 py-2 text-xs font-semibold text-slate-800 shadow-xl ring-1 ring-slate-900/5 sm:flex">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-indigo-50 text-indigo-700"><Layers className="h-3.5 w-3.5" /></span>Merged 3 files
      </div>
      <div className="hero-float absolute -bottom-5 left-10 hidden items-center gap-2 rounded-xl bg-white/95 px-3 py-2 text-xs font-semibold text-slate-800 shadow-xl ring-1 ring-slate-900/5 sm:flex">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-emerald-50 text-emerald-700"><Scissors className="h-3.5 w-3.5" /></span>Split by page range
      </div>
    </div>
  );
}
