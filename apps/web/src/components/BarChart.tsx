/** Minimal accessible bar chart (SVG). Values are also exposed as a text table for screen readers. */
export function BarChart({ data, label, height = 96 }: { data: { label: string; value: number }[]; label: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / Math.max(1, data.length);
  return (
    <figure>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label={label}>
        <title>{label}</title>
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 4);
          return <rect key={d.label} x={i * w + w * 0.12} y={height - h} width={w * 0.76} height={Math.max(h, d.value ? 1 : 0.5)} rx={0.6} className={d.value ? 'fill-brand-600' : 'fill-slate-200'}><title>{`${d.label}: ${d.value}`}</title></rect>;
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11px] text-slate-500"><span>{data[0]?.label}</span><span>{data.at(-1)?.label}</span></figcaption>
      <table className="sr-only"><caption>{label}</caption><tbody>{data.map((d) => <tr key={d.label}><th scope="row">{d.label}</th><td>{d.value}</td></tr>)}</tbody></table>
    </figure>
  );
}
