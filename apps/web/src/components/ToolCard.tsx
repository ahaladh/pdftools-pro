import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { ALL_TOOLS } from '@pdftools/shared';
import { ToolIcon } from '@/components/ToolIcon';
import { CATEGORY_STYLE } from '@/lib/category';
import { cn } from '@/lib/utils';

export function ToolCard({ id }: { id: string }) {
  const t = ALL_TOOLS.find((x) => x.id === id)!;
  const soon = t.status !== 'available';
  const s = CATEGORY_STYLE[t.category];
  return (
    <Link to={`/${t.id}`} className="group block h-full rounded-2xl">
      <div className="relative h-full rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-soft)] transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-brand-200 group-hover:shadow-[var(--shadow-lift)]">
        <div className="flex items-start gap-3.5">
          <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1 ring-inset transition-shadow', s.tile, s.ring)}><ToolIcon id={t.id} className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 font-semibold leading-snug text-slate-900">
              {t.name}
              {soon && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700">Soon</span>}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{t.short}</p>
          </div>
          {!soon && <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-400 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-brand-600 group-hover:opacity-100" aria-hidden="true" />}
        </div>
      </div>
    </Link>
  );
}
