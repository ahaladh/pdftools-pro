import { useRef, useState, type DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  accept: string;
  multiple: boolean;
  label: string;
  hint: string;
  onFiles: (files: File[]) => void;
  large?: boolean;
  disabled?: boolean;
}

export function Dropzone({ accept, multiple, label, hint, onFiles, large, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    if (disabled) return;
    const files = [...e.dataTransfer.files];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn(
        'group relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-gradient-to-b from-white to-slate-50 text-center transition-all duration-200',
        large ? 'px-6 py-14' : 'px-6 py-10',
        over ? 'scale-[1.01] border-brand-500 from-brand-50 to-brand-100 shadow-[0_0_0_6px_rgb(99_102_241/0.12)]' : 'border-slate-300 hover:border-brand-400',
      )}
    >
      <span className={cn('grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100 transition-transform duration-200', over ? 'scale-110' : 'group-hover:-translate-y-0.5')}>
        <UploadCloud className="h-7 w-7" aria-hidden="true" />
      </span>
      <p className="mt-4 text-base font-semibold text-slate-900">{label}</p>
      <p className="mt-1 text-sm text-slate-600">{hint}</p>
      <input
        ref={input} type="file" className="sr-only" accept={accept} multiple={multiple} tabIndex={-1} aria-label={label}
        onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) onFiles(files); e.target.value = ''; }}
      />
      <Button size="lg" className="mt-5" disabled={disabled} onClick={() => input.current?.click()}>
        Browse files
      </Button>
    </div>
  );
}
