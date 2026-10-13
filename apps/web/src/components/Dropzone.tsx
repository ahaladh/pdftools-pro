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
        'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white text-center transition-colors',
        large ? 'px-6 py-14' : 'px-6 py-10',
        over ? 'border-brand-500 bg-brand-50' : 'border-slate-300',
      )}
    >
      <UploadCloud className="h-10 w-10 text-brand-600" aria-hidden="true" />
      <p className="mt-3 text-base font-medium text-slate-900">{label}</p>
      <p className="mt-1 text-sm text-slate-500">{hint}</p>
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
