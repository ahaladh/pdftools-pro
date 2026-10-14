import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, Download, Loader2, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { getTool, isToolId, optionSchemas, type JobView } from '@pdftools/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dropzone } from '@/components/Dropzone';
import { FileList } from '@/components/FileList';
import { ToolIcon } from '@/components/ToolIcon';
import { ApiError, api } from '@/lib/api';
import { acceptAttr, acceptLabel, validateFile } from '@/lib/files';
import { formatBytes } from '@/lib/utils';
import { useSeo } from '@/hooks/useSeo';
import { usePending } from '@/stores/pending';
import { useAuth } from '@/stores/auth';
import NotFound from '@/pages/NotFound';
import { DEFAULT_OPTIONS, OptionPanel, preflight, toApiOptions } from './OptionPanel';
import { PageOrganizer } from './PageOrganizer';
import type { Built } from '@/features/workspace/model';

const Workspace = lazy(() => import('@/features/workspace/Workspace').then((m) => ({ default: m.Workspace })));
const ContentEditor = lazy(() => import('@/features/content/ContentEditor').then((m) => ({ default: m.ContentEditor })));
const WORKSPACE_TOOLS = ['edit', 'sign', 'redact', 'edit-content'] as const;

type Phase = 'select' | 'uploading' | 'processing' | 'done' | 'error';
const TERMINAL = ['completed', 'failed', 'cancelled', 'expired'];

export default function ToolPage() {
  const { toolId = '' } = useParams();
  const tool = getTool(toolId);
  if (!tool) return <NotFound />;
  return <ToolPageInner key={tool.id} toolId={tool.id} />;
}

function ToolPageInner({ toolId }: { toolId: string }) {
  const tool = getTool(toolId)!;
  const available = tool.status === 'available' && isToolId(toolId);
  const isWs = (WORKSPACE_TOOLS as readonly string[]).includes(toolId);
  /** Workspace tools take one PDF; extra image files come from the editor itself. */
  const multi = tool.multiple && !isWs;
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 5 * 60_000 });
  const maxBytes = (cfg.data?.limits.maxFileMB ?? 50) * 1024 * 1024;
  const maxFiles = cfg.data?.limits.maxFiles ?? 20;

  const [files, setFiles] = useState<File[]>([]);
  const [options, setOptions] = useState<Record<string, unknown>>(DEFAULT_OPTIONS[toolId] ?? {});
  const [ws, setWs] = useState<Built | null>(null);
  const [organizer, setOrganizer] = useState<{ order: string; rotations: Record<string, number>; count: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [uploadPct, setUploadPct] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pending = usePending();
  const signedIn = useAuth((a) => a.status === 'authenticated');

  useSeo({
    title: `${tool.name} online`,
    description: `${tool.short} ${tool.description}`.slice(0, 300),
    path: `/${tool.id}`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebApplication', name: tool.name, description: tool.description, applicationCategory: 'BusinessApplication', operatingSystem: 'Any' },
        ...(tool.faq.length ? [{ '@type': 'FAQPage', mainEntity: tool.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
      ],
    },
    noindex: false,
  });

  const addFiles = useCallback((incoming: File[]) => {
    const bad: string[] = [];
    const good = incoming.filter((f) => {
      const m = validateFile(f, tool, maxBytes) ?? (isWs && !/\.pdf$/i.test(f.name) && f.type !== 'application/pdf' ? `"${f.name}" is not a PDF.` : null);
      if (m) bad.push(m);
      return !m;
    });
    setProblems(bad);
    if (!good.length) return;
    setFiles((cur) => (multi ? [...cur, ...good].slice(0, tool.maxFiles ?? maxFiles) : [good[0]!]));
    if (!multi) { setOrganizer(null); setWs(null); }
  }, [tool, maxBytes, maxFiles, multi, isWs]);

  // Pick up files dropped on the homepage.
  useEffect(() => { const f = pending.take(); if (f.length) addFiles(f); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const jobQuery = useQuery({
    queryKey: ['job', jobId], enabled: !!jobId && (phase === 'processing' || phase === 'done'),
    queryFn: () => api.job(jobId!),
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.state) ? false : 800),
    retry: 2,
  });
  const job: JobView | undefined = jobQuery.data;

  useEffect(() => {
    if (!job) return;
    if (job.state === 'completed') setPhase('done');
    else if (job.state === 'failed') { setPhase('error'); setError(job.error?.message ?? 'Processing failed.'); }
    else if (job.state === 'cancelled') { setPhase('select'); setJobId(null); }
    else if (job.state === 'expired') { setPhase('error'); setError('This result has expired and was deleted. Please process the file again.'); }
  }, [job]);

  const buildOptions = (): unknown => {
    if (toolId === 'organize') return { order: organizer?.order ?? '', rotations: organizer?.rotations ?? {} };
    if (isWs) return ws?.options ?? {};
    return toApiOptions(toolId, options);
  };

  const run = async () => {
    setError(null); setErrorCode(null);
    if (!isToolId(toolId)) return;
    if (files.length < tool.minFiles) { setError(`Add at least ${tool.minFiles} file${tool.minFiles > 1 ? 's' : ''}.`); return; }
    if (isWs && !ws?.count) { setError(toolId === 'redact' ? 'Mark at least one area or enter text to find and redact.' : toolId === 'edit-content' ? 'Change some text or an image first.' : 'Add at least one annotation before saving.'); return; }
    const pre = preflight(toolId, options);
    if (pre) { setError(pre); return; }
    const parsed = optionSchemas[toolId].safeParse(buildOptions());
    if (!parsed.success) { setError(parsed.error.issues.map((i) => i.message).join('; ')); return; }
    const ac = new AbortController(); abortRef.current = ac;
    setPhase('uploading'); setUploadPct(0);
    try {
      const upload = isWs ? [files[0]!, ...(ws?.images ?? [])] : files;
      const { jobId } = await api.submit(toolId, upload, parsed.data, setUploadPct, ac.signal);
      setJobId(jobId); setPhase('processing');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'aborted') { setPhase('select'); return; }
      setPhase('error'); setError(e instanceof Error ? e.message : 'Upload failed.'); setErrorCode(e instanceof ApiError ? e.code : null);
    }
  };

  const reset = () => { setErrorCode(null); setWs(null); setFiles([]); setJobId(null); setPhase('select'); setError(null); setProblems([]); setOrganizer(null); setOptions(DEFAULT_OPTIONS[toolId] ?? {}); };
  const cancel = async () => { if (phase === 'uploading') abortRef.current?.abort(); else if (jobId) await api.cancel(jobId).catch(() => undefined); };

  const download = async () => {
    // Links are short-lived; fetch a fresh one at click time.
    try {
      const fresh = await api.job(jobId!);
      if (fresh.result) await api.download(fresh.result.downloadUrl, fresh.result.name);
    } catch (e) { setError(e instanceof Error ? e.message : 'Download failed.'); setErrorCode(e instanceof ApiError ? e.code : null); }
  };
  const deleteNow = async () => { if (job?.result) { await api.deleteFile(job.result.fileId).catch(() => undefined); reset(); } };

  const related = useMemo(() => tool.related.map(getTool).filter((t) => t?.status === 'available'), [tool]);
  const busy = phase === 'uploading' || phase === 'processing';

  return (
    <div className={`mx-auto ${isWs ? 'max-w-7xl' : 'max-w-5xl'} px-4 py-10 sm:px-6`}>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1 text-sm text-slate-500">
        <Link to="/" className="hover:text-brand-700">Home</Link><ChevronRight className="h-3 w-3" />
        <Link to="/tools" className="hover:text-brand-700">Tools</Link><ChevronRight className="h-3 w-3" />
        <span aria-current="page" className="text-slate-800">{tool.name}</span>
      </nav>
      <header className="mb-8 flex items-start gap-4">
        <span className="rounded-2xl bg-brand-50 p-3 text-brand-600"><ToolIcon id={tool.id} className="h-8 w-8" /></span>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{tool.name}</h1>
          <p className="mt-1 text-slate-600">{tool.short}</p>
        </div>
      </header>

      {!available ? (
        <Card className="p-8 text-center">
          <p className="text-lg font-semibold">{tool.name} is coming soon</p>
          <p className="mt-2 text-slate-600">This tool is on our roadmap but is not available yet, so we have not enabled it.</p>
          <Link to="/tools" className="mt-4 inline-block text-brand-700 underline">Browse available tools</Link>
        </Card>
      ) : (
        <Card className="p-6">
          {cfg.data?.maintenance && <p role="alert" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">The service is in maintenance mode; processing is temporarily unavailable.</p>}

          {phase === 'done' && job?.result ? (
            <Result job={job} onDownload={download} onAnother={reset} onDelete={deleteNow} toolId={toolId} />
          ) : (
            <>
              {(files.length === 0 || (multi && phase === 'select' && files.length < (tool.maxFiles ?? maxFiles))) && (
                <Dropzone
                  accept={isWs ? '.pdf,application/pdf' : acceptAttr(tool)} multiple={multi} disabled={busy}
                  label={files.length ? 'Add more files' : multi ? 'Drop your files here' : 'Drop your file here'}
                  hint={`${isWs ? 'PDF' : acceptLabel(tool)} · up to ${Math.round(maxBytes / 1024 / 1024)} MB each${multi ? ` · max ${maxFiles} files` : ''}`}
                  onFiles={addFiles}
                />
              )}
              {problems.length > 0 && (
                <ul role="alert" className="mt-3 space-y-1 rounded-xl bg-red-50 p-3 text-sm text-red-700">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
              )}
              {files.length > 0 && (
                <div className="mt-6 space-y-6">
                  <FileList files={files} onChange={(f) => { setFiles(f); setOrganizer(null); if (!f.length) setWs(null); }} sortable={multi && files.length > 1} disabled={busy} />
                  {isWs ? (
                    <Suspense fallback={<p className="text-sm text-slate-500" role="status">Loading editor…</p>}>
                      {tool.id === 'edit-content'
                        ? <ContentEditor key={files[0]!.name + files[0]!.size} file={files[0]!} disabled={busy} onChange={setWs} />
                        : <Workspace key={files[0]!.name + files[0]!.size} mode={tool.id as 'edit' | 'sign' | 'redact'} file={files[0]!} disabled={busy} onChange={setWs} />}
                    </Suspense>
                  ) : tool.id === 'organize' ? (
                    <PageOrganizer file={files[0]!} disabled={busy} onChange={(order, rotations, count) => setOrganizer({ order, rotations, count })} />
                  ) : (
                    <section aria-label="Settings"><h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Settings</h2><OptionPanel tool={tool.id} value={options} onChange={setOptions} disabled={busy} /></section>
                  )}
                  {tool.id === 'compress' && <p className="text-xs text-slate-500">The size reduction depends on your file and is shown after processing.</p>}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button size="lg" onClick={run} disabled={busy || files.length < tool.minFiles || cfg.data?.maintenance}>
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? 'Working…' : isWs ? (tool.id === 'redact' ? 'Apply redactions' : tool.id === 'edit-content' ? 'Apply edits' : 'Save PDF') : tool.name}
                    </Button>
                    {busy && <Button variant="secondary" size="lg" onClick={cancel}>Cancel</Button>}
                  </div>
                </div>
              )}
              {phase === 'uploading' && <Progress label="Uploading" pct={uploadPct} />}
              {phase === 'processing' && <Progress label={job?.state === 'queued' || !job ? 'Waiting in queue' : 'Processing'} pct={job?.progress ?? 5} />}
              {error && (
                <div role="alert" className="mt-4 flex items-start gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="flex-1"><p className="font-medium">{error}</p>
                    {(errorCode === 'upgrade_required' || errorCode === 'quota_exceeded') && <p className="mt-2"><Link to="/pricing" className="font-medium underline">See plans and limits</Link>{errorCode === 'quota_exceeded' && !signedIn && <> · <Link to="/register" className="underline">Create a free account</Link></>}</p>}
                    {phase === 'error' && errorCode !== 'upgrade_required' && errorCode !== 'quota_exceeded' && <div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" onClick={() => { setPhase('select'); setError(null); void run(); }}><RefreshCw className="h-3 w-3" />Retry</Button><Button size="sm" variant="ghost" onClick={reset}>Start over</Button></div>}
                  </div>
                </div>
              )}
            </>
          )}
          <p className="mt-6 flex items-start gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
            Your files are sent over an encrypted connection, stored privately, and deleted automatically
            {cfg.data ? ` within ${cfg.data.limits.retentionMinutes} minutes` : ''}. Uploaded originals are deleted as soon as processing finishes.
          </p>
        </Card>
      )}

      <section className="mt-12 grid gap-8 md:grid-cols-3">
        <div className="md:col-span-2">
          <h2 className="text-xl font-semibold">About {tool.name}</h2>
          <p className="mt-2 text-slate-600">{tool.description}</p>
          {tool.faq.length > 0 && (
            <div className="mt-6 space-y-4">
              <h2 className="text-xl font-semibold">Frequently asked questions</h2>
              {tool.faq.map((f) => <details key={f.q} className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer font-medium">{f.q}</summary><p className="mt-2 text-sm text-slate-600">{f.a}</p></details>)}
            </div>
          )}
        </div>
        <aside>
          <h2 className="text-xl font-semibold">Related tools</h2>
          <ul className="mt-3 space-y-2">
            {related.map((t) => <li key={t!.id}><Link to={`/${t!.id}`} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-sm hover:border-brand-500"><ToolIcon id={t!.id} className="h-4 w-4 text-brand-600" />{t!.name}</Link></li>)}
          </ul>
        </aside>
      </section>
    </div>
  );
}

function Progress({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="mt-6" role="status" aria-live="polite">
      <div className="mb-1 flex justify-between text-sm text-slate-700"><span>{label}…</span><span>{pct}%</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Result({ job, onDownload, onAnother, onDelete, toolId }: { job: JobView; onDownload: () => void; onAnother: () => void; onDelete: () => void; toolId: string }) {
  const s = job.stats;
  return (
    <div className="text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden="true" />
      <h2 className="mt-3 text-2xl font-semibold">Your file is ready</h2>
      <p className="mt-1 text-sm text-slate-600">{job.result!.name} · {formatBytes(job.result!.bytes)}</p>
      {toolId === 'compress' && s && (
        <dl className="mx-auto mt-5 grid max-w-md grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Original</dt><dd className="font-semibold">{formatBytes(Number(s.originalBytes))}</dd></div>
          <div className="rounded-xl bg-slate-50 p-3"><dt className="text-slate-500">Compressed</dt><dd className="font-semibold">{formatBytes(Number(s.compressedBytes))}</dd></div>
          <div className="rounded-xl bg-emerald-50 p-3"><dt className="text-emerald-700">Reduction</dt><dd className="font-semibold text-emerald-800">{Number(s.reductionPercent)}%</dd></div>
        </dl>
      )}
      {job.warnings.length > 0 && <ul className="mx-auto mt-4 max-w-md space-y-1 rounded-xl bg-amber-50 p-3 text-left text-sm text-amber-800">{job.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button size="lg" onClick={onDownload}><Download className="h-4 w-4" />Download</Button>
        <Button size="lg" variant="secondary" onClick={onAnother}>Process another file</Button>
        <Button size="lg" variant="ghost" onClick={onDelete}><Trash2 className="h-4 w-4" />Delete now</Button>
      </div>
    </div>
  );
}
