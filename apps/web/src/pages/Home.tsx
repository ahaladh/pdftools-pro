import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileCheck2, Gauge, ShieldCheck, Layers, Upload, Settings2, Download } from 'lucide-react';
import { TOOLS, CATEGORY_LABELS, type ToolCategory } from '@pdftools/shared';
import { Dropzone } from '@/components/Dropzone';
import { Card } from '@/components/ui/card';
import { buttonClass } from '@/components/ui/button';
import { ToolCard } from '@/components/ToolCard';
import { api } from '@/lib/api';
import { useSeo } from '@/hooks/useSeo';
import { usePending } from '@/stores/pending';
import { BRAND } from '@/lib/utils';

const FAQ = [
  { q: 'Are my files private?', a: 'Files are uploaded over an encrypted connection to private storage that only your browser session can access. Originals are deleted as soon as processing finishes and results are deleted automatically after the retention period shown on each tool page. You can also delete a result immediately.' },
  { q: 'Do I need an account?', a: 'No. Basic tools work without signing up, within the daily and file-size limits shown on each tool page. An account adds a higher limit and job history; some premium tools need a paid plan.' },
  { q: 'Which tools actually work today?', a: 'Merge, split, extract, organize, rotate, crop, resize, compress, repair, page numbers, watermark, add text/shapes/images, edit existing text and images, visual signature, true redaction (drawn areas or find-and-redact text), password protect/unlock, Office-to-PDF, PDF to Word/Excel/PowerPoint/text/HTML/images, image extraction and text comparison. Tools marked “Soon” (OCR, form filling, PDF/A) are not available yet.' },
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

  return (
    <>
      <section className="bg-gradient-to-b from-brand-50 to-white">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">Every PDF Tool You Need. All in One Place.</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600">Edit, convert, compress, merge, split, and secure your PDF files with simple online tools.</p>
          <div className="mt-10 text-left">
            {dropped.length === 0 ? (
              <Dropzone large multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" label="Drop a PDF or images here" hint="PDF, JPG or PNG · then choose what to do" onFiles={setDropped} />
            ) : (
              <Card className="p-6">
                <p className="font-medium">{dropped.length === 1 ? dropped[0]!.name : `${dropped.length} files selected`} — what would you like to do?</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {options.map((t) => <button key={t.id} type="button" onClick={() => go(t.id)} className="rounded-xl border border-slate-200 p-3 text-left hover:border-brand-500 hover:bg-brand-50"><span className="font-medium">{t.name}</span><span className="block text-xs text-slate-500">{t.short}</span></button>)}
                </div>
                <button type="button" className="mt-4 text-sm text-slate-500 underline" onClick={() => setDropped([])}>Choose different files</button>
              </Card>
            )}
          </div>
          <p className="mt-4 flex items-center justify-center gap-2 text-sm text-slate-500"><ShieldCheck className="h-4 w-4 text-emerald-600" />Private by design · files auto-deleted{cfg.data ? ` within ${cfg.data.limits.retentionMinutes} min` : ''}</p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6" aria-labelledby="popular">
        <h2 id="popular" className="text-2xl font-bold">Popular tools</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{TOOLS.filter((t) => t.popular).map((t) => <ToolCard key={t.id} id={t.id} />)}</div>
      </section>

      <section className="bg-slate-50 py-16" aria-labelledby="cats">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <h2 id="cats" className="text-2xl font-bold">Tools by use case</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {cats.map((c) => (
              <Card key={c} className="p-5">
                <h3 className="font-semibold">{CATEGORY_LABELS[c]}</h3>
                <ul className="mt-3 space-y-2 text-sm">{TOOLS.filter((t) => t.category === c).map((t) => <li key={t.id}><Link className="text-slate-600 hover:text-brand-700" to={`/${t.id}`}>{t.name}</Link></li>)}</ul>
              </Card>
            ))}
          </div>
          <p className="mt-6 text-sm"><Link to="/tools" className="text-brand-700 underline">See all tools, including upcoming ones →</Link></p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6" aria-labelledby="why">
        <h2 id="why" className="text-2xl font-bold">Built for privacy, speed and convenience</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { i: ShieldCheck, t: 'Private', d: 'Isolated per-session storage, signed short-lived download links, automatic deletion.' },
            { i: Gauge, t: 'Fast', d: 'Heavy work runs in background workers with progress you can follow.' },
            { i: Layers, t: 'No sign-up', d: 'Use available tools instantly, within clearly shown limits.' },
            { i: FileCheck2, t: 'Honest results', d: 'We tell you when a file cannot be improved or a feature is not supported.' },
          ].map(({ i: Icon, t, d }) => <div key={t}><Icon className="h-6 w-6 text-brand-600" aria-hidden="true" /><h3 className="mt-3 font-semibold">{t}</h3><p className="mt-1 text-sm text-slate-600">{d}</p></div>)}
        </div>
      </section>

      <section className="bg-slate-50 py-16" aria-labelledby="how">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <h2 id="how" className="text-2xl font-bold">How it works</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {[{ i: Upload, t: '1. Upload', d: 'Drop your files or browse.' }, { i: Settings2, t: '2. Choose settings', d: 'Pick ranges, quality or order.' }, { i: Download, t: '3. Download', d: 'Get your result, then delete it right away if you like.' }].map(({ i: Icon, t, d }) => (
              <li key={t} className="rounded-2xl border border-slate-200 bg-white p-6"><Icon className="h-6 w-6 text-brand-600" aria-hidden="true" /><h3 className="mt-3 font-semibold">{t}</h3><p className="mt-1 text-sm text-slate-600">{d}</p></li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6" aria-labelledby="pricing">
        <h2 id="pricing" className="text-2xl font-bold">Free to start</h2>
        <p className="mt-2 text-slate-600">Use the basic tools without an account. Create a free account for a higher daily limit and job history, or upgrade for larger files and premium tools.</p>
        <Link to="/pricing" className={buttonClass({ variant: 'secondary', className: 'mt-4' })}>View plans</Link>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-8 sm:px-6" aria-labelledby="faq">
        <h2 id="faq" className="text-2xl font-bold">Frequently asked questions</h2>
        <div className="mt-6 space-y-3">{FAQ.map((f) => <details key={f.q} className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer font-medium">{f.q}</summary><p className="mt-2 text-sm text-slate-600">{f.a}</p></details>)}</div>
        <p className="mt-6 text-center text-xs text-slate-600">{BRAND}</p>
      </section>
    </>
  );
}
