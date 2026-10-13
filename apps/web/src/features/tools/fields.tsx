import { forwardRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const base = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-500';
// forwardRef is required: react-hook-form attaches its ref to these inputs.
export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(base, className)} {...p} />);
TextInput.displayName = 'TextInput';
export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => <select ref={ref} className={cn(base, className)} {...p} />);
Select.displayName = 'Select';

export function Radio<T extends string>({ name, value, onChange, options }: { name: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; desc?: string }[] }) {
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{name}</legend>
      {options.map((o) => (
        <label key={o.value} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3', value === o.value ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}>
          <input type="radio" name={name} className="mt-1" checked={value === o.value} onChange={() => onChange(o.value)} />
          <span><span className="block text-sm font-medium text-slate-900">{o.label}</span>{o.desc && <span className="block text-xs text-slate-500">{o.desc}</span>}</span>
        </label>
      ))}
    </fieldset>
  );
}
