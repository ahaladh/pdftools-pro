import { Link } from 'react-router-dom';
import { ALL_TOOLS } from '@pdftools/shared';
import { Card } from '@/components/ui/card';
import { ToolIcon } from '@/components/ToolIcon';

export function ToolCard({ id }: { id: string }) {
  const t = ALL_TOOLS.find((x) => x.id === id)!;
  const soon = t.status !== 'available';
  return (
    <Link to={`/${t.id}`} className="group block h-full">
      <Card className="h-full p-5 transition-shadow group-hover:shadow-md group-hover:border-brand-500">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-brand-50 p-2 text-brand-600"><ToolIcon id={t.id} className="h-5 w-5" /></span>
          <h3 className="font-semibold text-slate-900">{t.name}</h3>
          {soon && <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-700">Soon</span>}
        </div>
        <p className="mt-2 text-sm text-slate-600">{t.short}</p>
      </Card>
    </Link>
  );
}
