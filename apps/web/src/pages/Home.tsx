import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FileCheck2, Gauge, ShieldCheck, Layers, Upload, Settings2, Download, Lock, Trash2, Sparkles } from 'lucide-react';
import { TOOLS, CATEGORY_LABELS, type ToolCategory } from '@pdftools/shared';
import { Dropzone } from '@/components/Dropzone';
import { Card } from '@/components/ui/card';
import { buttonClass } from '@/components/ui/button';
import { ToolCard } from '@/components/ToolCard';
import { HeroPreview } from '@/components/HeroPreview';
import { api } from '@/lib/api';
import { useSeo } from '@/hooks/useSeo';
import { usePending } from '@/stores/pending';
import { CATEGORY_STYLE } from '@/lib/category';
import { BRAND, cn } from '@/lib/utils';

const FAQ = [
  { q: 'Are my files private?', a: 'Files are uploaded over an encrypted connection to private storage that only your browser session can access. Originals are deleted as soon as processing finishes and results are deleted automatically after the retention period shown on each tool page. You can also delete a result immediately.' },
  { q: 'Do I need an account?', a: 'No. Basic tools work without signing up, within the daily and file-size limits shown on each tool page. An account adds a higher limit and job history; some premium tools need a paid plan.' },
  { q: 'Which tools actually work today?', a: 'Merge, split, extract, organize, rotate, crop, resize, compress, repair, page numbers, watermark, add text/shapes/images, edit existing text and images, OCR for scans, PDF/A conversion, visual signature, true redaction (drawn areas or find-and-redact text), password protect/unlock, Office-to-PDF, PDF to Word/Excel/PowerPoint/text/HTML/images, image extraction and text comparison. Tools marked “Soon” (form filling) are not available yet.' },
  { q: 'Will compression always make my file smaller?', a: 'No. Results depend on the content. If a file cannot be reduced, we return the original unchanged and tell you.' },
];

export default function Home() {
  useSeo({
    title: 'Every PDF Tool You Need. All in One Place.',
    description: 'Edit, convert, compress, merge, split, and secure your PDF files with simple online tools.',
    path: '/',
    jsonLd: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
  });
  const nav = useNavigate();
  const setPending = usePending((s) => s.set);
  const [dropped, setDropped] = useState<File[]>([]);
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 5 * 60_000 });

  const kinds = new Set(dropped.map((f) => (f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'pdf' : 'image')));
  const options = TOOLS.filter((t) => (kinds.has('pdf') && t.accept.includes('pdf') && (dropped.length === 1 ? true : t.multiple)) || (kinds.has('image') && t.accept.includes('jpg')));
  const go = (id: string) => { setPending(dropped); nav(`/${id}`); };
  const cats = (['organize', 'edit', 'convert', 'compress'] as ToolCategory[]);
  const allCats = (Object.keys(CATEGORY_LABELS) as ToolCategory[]).filter((c) => TOOLS.some((t) => t.category === c));
  const [tab, setTab] = useState<'popular' | ToolCategory>('popular');
  const shown = tab === 'popular' ? TOOLS.filter((t) => t.popular) : TOOLS.filter((t) => t.category === tab);

  return (
    <>
      <section className="hero-bg hero-fade relative isolate overflow-hidden text-white">
        <div className="hero-grid pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 pb-24 pt-14 sm:px-6 sm:pb-32 sm:pt-20 lg:grid-cols-[1.08fr_0.92fr] lg:gap-10">
          <div className="text-center lg:text-left">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-medium text-brand-100 ring-1 ring-inset ring-white/15 backdrop-blur"><Sparkles className="h-3.5 w-3.5 text-brand-300" aria-hidden="true" />Edit text and images, OCR scans, convert to PDF/A</p>
          <h1 className="mt-6 text-4xl font-extrabold leading-[1.06] tracking-tight sm:text-6xl xl:text-[4.25rem]">Every PDF Tool You Need. <span className="text-gradient">All in One Place.</span></h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-300 lg:mx-0">Edit, convert, compress, merge, split, and secure your PDF files with simple online tools.</p>
          <div className="mt-9 rounded-3xl bg-white/[0.07] p-2 text-left shadow-[var(--shadow-glow)] ring-1 ring-inset ring-white/15 backdrop-blur-sm sm:p-3">
            {dropped.length === 0 ? (
              <Dropzone large multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" label="Drop a PDF or images here" hint="PDF, JPG or PNG · then choose what to do" onFiles={setDropped} />
            ) : (
              <Card className="p-6 text-slate-900">
                <p className="font-medium">{dropped.length === 1 ? dropped[0]!.name : `${dropped.length} files selected`} — what would you like to do?</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {options.map((t) => <button key={t.id} type="button" onClick={() => go(t.id)} className="group rounded-xl border border-slate-200 p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:bg-brand-50/60 hover:shadow-[var(--shadow-soft)]"><span className="flex items-center gap-2 font-medium">{t.name}<ArrowRight className="ml-auto h-4 w-4 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600" aria-hidden="true" /></span><span className="mt-0.5 block text-xs text-slate-600">{t.short}</span></button>)}
                </div>
                <button type="button" className="mt-4 text-sm text-slate-600 underline underline-offset-2 hover:text-slate-900" onClick={() => setDropped([])}>Choose different files</button>
              </Card>
            )}
          </div>
          <p className="mt-5 flex items-center justify-center gap-2 text-sm text-slate-300 lg:justify-start"><ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" />Private by design · files auto-deleted{cfg.data ? ` within ${cfg.data.limits.retentionMinutes} min` : ''}</p>
          <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-slate-300 lg:justify-start">
            {[{ i: Lock, t: 'Encrypted in transit' }, { i: Trash2, t: 'Auto-deleted' }, { i: Layers, t: 'No sign-up needed' }].map(({ i: Icon, t }) => <li key={t} className="flex items-center gap-2"><Icon className="h-4 w-4 text-brand-300" aria-hidden="true" />{t}</li>)}
          </ul>
          </div>
          <div className="hidden lg:block"><HeroPreview /></div>
        </div>
      </section>

      <section className="mx-auto -mt-6 max-w-5xl px-4 sm:px-6" aria-label="Key facts">
        <dl className="grid gap-px overflow-hidden rounded-2xl bg-slate-200/70 shadow-[var(--shadow-lift)] ring-1 ring-slate-200/70 sm:grid-cols-3">
          {[
            { v: String(TOOLS.length), l: 'tools ready to use' },
            { v: cfg.data ? `${cfg.data.limits.retentionMinutes} min` : '60 min', l: 'until your files are deleted' },
            { v: 'No sign-up', l: 'needed for the basic tools' },
          ].map((f) => <div key={f.l} className="bg-white px-6 py-5 text-center"><dd className="text-2xl font-bold tracking-tight text-slate-900">{f.v}</dd><dt className="mt-0.5 text-sm text-slate-600">{f.l}</dt></div>)}
        </dl>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6" aria-labelledby="popular">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-700">Start here</p>
            <h2 id="popular" className="mt-1 text-3xl font-bold tracking-tight">Popular tools</h2>
          </div>
          <div role="group" aria-label="Filter tools by category" className="flex flex-wrap gap-1.5">
            {(['popular', ...allCats] as const).map((c) => (
              <button key={c} type="button" aria-pressed={tab === c} onClick={() => setTab(c)}
                className={cn('rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors', tab === c ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50')}>
                {c === 'popular' ? 'Popular' : CATEGORY_LABELS[c].replace(' PDF', '')}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{shown.map((t) => <ToolCard key={t.id} id={t.id} />)}</div>
      </section>

      <section className="border-y border-slate-200/70 bg-gradient-to-b from-slate-50 to-white py-20" aria-labelledby="cats">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-700">Everything in one place</p>
          <h2 id="cats" className="mt-1 text-3xl font-bold tracking-tight">Tools by use case</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {cats.map((c) => (
              <Card key={c} className="p-6 transition-shadow hover:shadow-[var(--shadow-lift)]">
                <h3 className="flex items-center gap-2.5 font-semibold"><span className={cn('h-2 w-2 rounded-full', CATEGORY_STYLE[c].dot)} aria-hidden="true" />{CATEGORY_LABELS[c]}</h3>
                <ul className="mt-4 space-y-2.5 text-sm">{TOOLS.filter((t) => t.category === c).map((t) => <li key={t.id}><Link className="text-slate-600 transition-colors hover:text-brand-700" to={`/${t.id}`}>{t.name}</Link></li>)}</ul>
              </Card>
            ))}
          </div>
          <p className="mt-8 text-sm font-medium"><Link to="/tools" className="inline-flex items-center gap-1.5 text-brand-700 hover:text-brand-800">See all tools, including upcoming ones <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6" aria-labelledby="why">
        <h2 id="why" className="max-w-2xl text-3xl font-bold tracking-tight">Built for privacy, speed and convenience</h2>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { i: ShieldCheck, t: 'Private', d: 'Isolated per-session storage, signed short-lived download links, automatic deletion.' },
            { i: Gauge, t: 'Fast', d: 'Heavy work runs in background workers with progress you can follow.' },
            { i: Layers, t: 'No sign-up', d: 'Use available tools instantly, within clearly shown limits.' },
            { i: FileCheck2, t: 'Honest results', d: 'We tell you when a file cannot be improved or a feature is not supported.' },
          ].map(({ i: Icon, t, d }) => <div key={t} className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-soft)]"><span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-50 to-violet-50 text-brand-700 ring-1 ring-inset ring-brand-100"><Icon className="h-5 w-5" aria-hidden="true" /></span><h3 className="mt-5 font-semibold">{t}</h3><p className="mt-1.5 text-sm leading-relaxed text-slate-600">{d}</p></div>)}
        </div>
      </section>

      <section className="border-y border-slate-200/70 bg-slate-50 py-20" aria-labelledby="how">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <h2 id="how" className="text-3xl font-bold tracking-tight">How it works</h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {[{ i: Upload, t: '1. Upload', d: 'Drop your files or browse.' }, { i: Settings2, t: '2. Choose settings', d: 'Pick ranges, quality or order.' }, { i: Download, t: '3. Download', d: 'Get your result, then delete it right away if you like.' }].map(({ i: Icon, t, d }) => (
              <li key={t} className="relative rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[var(--shadow-soft)]"><span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-600 text-white shadow-[0_8px_20px_-8px_rgb(79_70_229/0.8)]"><Icon className="h-5 w-5" aria-hidden="true" /></span><h3 className="mt-5 font-semibold">{t}</h3><p className="mt-1.5 text-sm leading-relaxed text-slate-600">{d}</p></li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6" aria-labelledby="pricing">
        <div className="cta-band relative overflow-hidden rounded-3xl px-6 py-14 text-center text-white shadow-[var(--shadow-lift)] sm:px-12">
          <h2 id="pricing" className="text-3xl font-bold tracking-tight">Free to start</h2>
          <p className="mx-auto mt-3 max-w-2xl leading-relaxed text-brand-100">Use the basic tools without an account. Create a free account for a higher daily limit and job history, or upgrade for larger files and premium tools.</p>
          <Link to="/pricing" className="mt-7 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 font-medium text-brand-800 shadow-lg transition-all hover:bg-brand-50 active:scale-[0.98]">View plans <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-8 sm:px-6" aria-labelledby="faq">
        <h2 id="faq" className="text-3xl font-bold tracking-tight">Frequently asked questions</h2>
        <div className="mt-8 space-y-3">{FAQ.map((f) => <details key={f.q} className="group rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-[var(--shadow-soft)] open:border-brand-200 open:shadow-[var(--shadow-lift)]"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">{f.q}<span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600 transition-transform group-open:rotate-45" aria-hidden="true">+</span></summary><p className="mt-3 text-sm leading-relaxed text-slate-600">{f.a}</p></details>)}</div>
        <p className="mt-6 text-center text-xs text-slate-600">{BRAND}</p>
      </section>
    </>
  );
}
