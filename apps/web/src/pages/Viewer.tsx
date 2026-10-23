import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, FileText, Lock, ScanText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dropzone } from '@/components/Dropzone';
import { useSeo } from '@/hooks/useSeo';

const Viewer = lazy(() => import('@/features/viewer/Viewer').then((m) => ({ default: m.Viewer })));

/** The most we will try to open in the browser; bigger files make a tab unresponsive. This is a courtesy, not a security limit. */
const MAX_MB = 300;

export default function ViewerPage() {
  useSeo({
    title: 'View PDF online', path: '/view',
    description: 'Open and read a PDF in your browser: zoom, search the whole document, select and copy text, jump between pages. The file never leaves your device.',
  });
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return void setProblem(`"${f.name}" is not a PDF.`);
    if (f.size > MAX_MB * 1024 * 1024) return void setProblem(`"${f.name}" is larger than ${MAX_MB} MB, which is more than a browser tab can open comfortably.`);
    if (f.size === 0) return void setProblem(`"${f.name}" is empty.`);
    setProblem(null); setFile(f);
  };

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12 pt-8 sm:px-6">
      <header className="mb-8 flex items-start gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200"><Eye className="h-7 w-7" aria-hidden="true" /></span>
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">View PDF</h1>
          <p className="mt-1.5 text-base text-slate-600">Read a PDF right here. It opens on your device and is <b>never uploaded</b>.</p>
        </div>
      </header>

      <Card className="p-6 shadow-[var(--shadow-lift)] sm:p-8">
        {!file ? (
          <>
            <Dropzone accept=".pdf,application/pdf" multiple={false} label="Drop a PDF here" hint={`PDF · up to ${MAX_MB} MB · stays on your device`} onFiles={pick} />
            {problem && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{problem}</p>}
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <FileText className="h-4 w-4 text-slate-500" aria-hidden="true" /><span className="font-medium">{file.name}</span>
              <Button size="sm" variant="secondary" onClick={() => { setFile(null); setProblem(null); }}>Open another file</Button>
            </div>
            <Suspense fallback={<p role="status" className="text-sm text-slate-500">Loading the viewer…</p>}><Viewer file={file} /></Suspense>
          </div>
        )}
      </Card>

      <section className="mt-10 grid gap-4 sm:grid-cols-3" aria-label="Related tools">
        <Link to="/ocr" className="flex items-start gap-3 rounded-xl border border-slate-200/80 bg-white p-4 text-sm shadow-[var(--shadow-soft)] transition-colors hover:border-brand-200"><ScanText className="mt-0.5 h-5 w-5 text-slate-500" aria-hidden="true" /><span><b className="block">Scanned document?</b>Make it searchable with OCR PDF.</span></Link>
        <Link to="/unlock" className="flex items-start gap-3 rounded-xl border border-slate-200/80 bg-white p-4 text-sm shadow-[var(--shadow-soft)] transition-colors hover:border-brand-200"><Lock className="mt-0.5 h-5 w-5 text-slate-500" aria-hidden="true" /><span><b className="block">Password-protected?</b>Remove the password with Unlock PDF.</span></Link>
        <Link to="/edit" className="flex items-start gap-3 rounded-xl border border-slate-200/80 bg-white p-4 text-sm shadow-[var(--shadow-soft)] transition-colors hover:border-brand-200"><FileText className="mt-0.5 h-5 w-5 text-slate-500" aria-hidden="true" /><span><b className="block">Need to change it?</b>Add text, shapes or images with Edit PDF.</span></Link>
      </section>

      <section className="mt-10 max-w-3xl space-y-3" aria-label="Questions">
        <h2 className="text-xl font-semibold">Questions</h2>
        {[
          ['Is my file uploaded?', 'No. The PDF is read and drawn by your browser on this page. Nothing is sent to our servers, so there is nothing to delete afterwards.'],
          ['Can it search a scanned PDF?', 'Only if the scan has a text layer. A scan that is just pictures has no text to find; run it through OCR PDF first, which adds an invisible text layer.'],
          ['How does search work?', 'It looks for your words anywhere in the document, ignoring capitals unless you tick Match case, and across line breaks. Matches are shown on the page and in the thumbnails; Enter goes to the next one, Shift+Enter to the previous.'],
        ].map(([q, a]) => (
          <details key={q} className="group rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-[var(--shadow-soft)] open:border-brand-200"><summary className="cursor-pointer list-none font-medium">{q}</summary><p className="mt-2 text-sm leading-relaxed text-slate-700">{a}</p></details>
        ))}
      </section>
    </div>
  );
}
