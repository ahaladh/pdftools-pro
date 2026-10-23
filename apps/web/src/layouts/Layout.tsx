import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { ChevronDown, Menu, X, ShieldCheck } from 'lucide-react';
import { CATEGORY_LABELS, TOOLS, PLANNED_TOOLS, type ToolCategory } from '@pdftools/shared';
import { Logo } from '@/components/Logo';
import { ToolIcon } from '@/components/ToolIcon';
import { buttonClass } from '@/components/ui/button';
import { CATEGORY_STYLE } from '@/lib/category';
import { BRAND, cn } from '@/lib/utils';


function MegaMenu({ onNavigate }: { onNavigate: () => void }) {
  const cats = Object.keys(CATEGORY_LABELS) as ToolCategory[];
  return (
    <div className="grid gap-x-8 gap-y-7 p-6 sm:grid-cols-2 lg:grid-cols-3">
      {cats.map((c) => {
        const available = TOOLS.filter((t) => t.category === c);
        const planned = PLANNED_TOOLS.filter((t) => t.category === c);
        if (!available.length && !planned.length) return null;
        return (
          <div key={c}>
            <p className="mb-2.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600"><span className={cn('h-1.5 w-1.5 rounded-full', CATEGORY_STYLE[c].dot)} aria-hidden="true" />{CATEGORY_LABELS[c]}</p>
            <ul className="space-y-1">
              {available.map((t) => (
                <li key={t.id}>
                  <Link to={`/${t.id}`} onClick={onNavigate} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-700 transition-colors hover:bg-brand-50 hover:text-brand-700">
                    <ToolIcon id={t.id} className="h-4 w-4 text-slate-500" />{t.name}
                  </Link>
                </li>
              ))}
              {planned.map((t) => (
                <li key={t.id} className="flex items-center gap-2 px-2 py-1.5 text-sm text-slate-600">
                  <ToolIcon id={t.id} className="h-4 w-4" />{t.name}<span className="ml-auto rounded-md bg-slate-100 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700">Soon</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function AccountLinks({ mobile }: { mobile?: boolean }) {
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000 });
  const { status, user } = useAuth();
  if (!cfg.data?.features.accounts || status === 'loading') return null;
  const cls = mobile ? 'w-full' : '';
  return status === 'authenticated' ? (
    <Link to="/account" className={buttonClass({ variant: 'secondary', size: 'sm', className: cls })}>{user?.name || 'Account'}</Link>
  ) : (
    <>
      <Link to="/signin" className={buttonClass({ variant: 'ghost', size: 'sm', className: cls })}>Sign in</Link>
      <Link to="/register" className={buttonClass({ size: 'sm', className: cls })}>Get started</Link>
    </>
  );
}

function Header() {
  const [mega, setMega] = useState(false);
  const [mobile, setMobile] = useState(false);
  const loc = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setMega(false); setMobile(false); }, [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMega(false);
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setMega(false);
    document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, []);
  const link = ({ isActive }: { isActive: boolean }) => cn('whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900', isActive && 'bg-brand-50 text-brand-700 hover:bg-brand-50 hover:text-brand-700');
  const quick = [
    { to: '/compress', label: 'Compress PDF' }, { to: '/merge', label: 'Merge PDF' }, { to: '/split', label: 'Split PDF' },
    { to: '/pdf-to-images', label: 'Convert PDF' }, { to: '/watermark', label: 'Edit PDF' },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6" ref={ref}>
        <div className="shrink-0"><Logo /></div>
        <nav aria-label="Primary" className="ml-4 hidden items-center gap-1 lg:flex">
          <button type="button" aria-expanded={mega} aria-controls="mega" onClick={() => setMega((v) => !v)} className={cn('flex items-center gap-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900', mega && 'bg-slate-100 text-slate-900')}>
            All PDF Tools <ChevronDown className={cn('h-4 w-4 transition-transform', mega && 'rotate-180')} aria-hidden="true" />
          </button>
          {quick.map((q) => <NavLink key={q.to} to={q.to} className={link}>{q.label}</NavLink>)}
          <NavLink to="/pricing" className={link}>Pricing</NavLink>
        </nav>
        <div className="ml-auto hidden items-center gap-2 whitespace-nowrap text-sm text-slate-600 lg:flex">
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-100 xl:flex"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />Files auto-deleted</span>
          <AccountLinks />
        </div>
        <button type="button" className="ml-auto rounded-lg p-2 hover:bg-slate-100 lg:hidden" aria-label={mobile ? 'Close menu' : 'Open menu'} aria-expanded={mobile} onClick={() => setMobile((v) => !v)}>
          {mobile ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {mega && <div id="mega" className="absolute inset-x-0 top-16 hidden border-b border-slate-200 bg-white/95 shadow-[0_24px_48px_-24px_rgb(15_23_42/0.25)] backdrop-blur-xl lg:block"><div className="mx-auto max-w-7xl"><MegaMenu onNavigate={() => setMega(false)} /></div></div>}
      {mobile && <div className="max-h-[80vh] overflow-y-auto border-t border-slate-200 bg-white lg:hidden"><MegaMenu onNavigate={() => setMobile(false)} /><div className="space-y-2 border-t p-4"><Link to="/pricing" className={buttonClass({ variant: 'secondary', className: 'w-full' })}>Pricing</Link><AccountLinks mobile /></div></div>}
    </header>
  );
}

function Footer() {
  const cats = (['organize', 'edit', 'convert', 'compress'] as ToolCategory[]);
  const linkCls = 'text-slate-400 transition-colors hover:text-white';
  return (
    <footer className="relative mt-24 bg-ink text-slate-300">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-400/60 to-transparent" aria-hidden="true" />
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-6">
        <div className="sm:col-span-2 lg:col-span-1">
          <Logo onDark />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-400">Practical PDF tools with automatic file deletion.</p>
          <p className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-white/10"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />Private by design</p>
        </div>
        {cats.map((c) => (
          <div key={c}>
            <p className="text-sm font-semibold text-white">{CATEGORY_LABELS[c]}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {TOOLS.filter((t) => t.category === c).map((t) => <li key={t.id}><Link className={linkCls} to={`/${t.id}`}>{t.name}</Link></li>)}
            </ul>
          </div>
        ))}
        <div>
          <p className="text-sm font-semibold text-white">Company</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><Link className={linkCls} to="/tools">All tools</Link></li>
            <li><Link className={linkCls} to="/view">View PDF</Link></li>
            <li><Link className={linkCls} to="/pricing">Pricing</Link></li>
            <li><Link className={linkCls} to="/privacy">Privacy policy</Link></li>
            <li><Link className={linkCls} to="/terms">Terms of service</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10 py-6 text-center text-xs text-slate-400">© {new Date().getFullYear()} {BRAND}. All rights reserved.</div>
    </footer>
  );
}

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <Header />
      <main id="main" className="flex-1" tabIndex={-1}>
        {/* Only the page content suspends while a lazy route loads: header, footer and focus stay put. */}
        <Suspense fallback={<div className="p-12 text-center text-slate-600" role="status">Loading…</div>}><Outlet /></Suspense>
      </main>
      <Footer />
    </div>
  );
}
