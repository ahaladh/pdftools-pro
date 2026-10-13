import { ALL_TOOLS, CATEGORY_LABELS, type ToolCategory } from '@pdftools/shared';
import { ToolCard } from '@/components/ToolCard';
import { useSeo } from '@/hooks/useSeo';

export default function Tools() {
  useSeo({ title: 'All PDF tools', description: 'Browse every PDF tool: merge, split, compress, rotate, organize, watermark, page numbers and image conversion.', path: '/tools' });
  const cats = Object.keys(CATEGORY_LABELS) as ToolCategory[];
  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">All PDF tools</h1>
      <p className="mt-2 text-slate-600">Tools marked “Soon” are on the roadmap and are not yet functional.</p>
      {cats.map((c) => {
        const list = ALL_TOOLS.filter((t) => t.category === c);
        if (!list.length) return null;
        return (
          <section key={c} className="mt-10" aria-labelledby={`cat-${c}`}>
            <h2 id={`cat-${c}`} className="mb-4 text-lg font-semibold">{CATEGORY_LABELS[c]}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{list.map((t) => <ToolCard key={t.id} id={t.id} />)}</div>
          </section>
        );
      })}
    </div>
  );
}
