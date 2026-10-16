import { useState } from 'react';
import { ArrowDown, ArrowUp, File as FileIcon, GripVertical, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes, cn } from '@/lib/utils';

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  sortable: boolean;
  disabled?: boolean;
}

/** Selected file list with removal and drag-and-drop (plus buttons for keyboard users) reordering. */
export function FileList({ files, onChange, sortable, disabled }: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length || from === to) return;
    const next = [...files];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  return (
    <ul className="space-y-2" aria-label="Selected files">
      {files.map((f, i) => (
        <li
          key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
          draggable={sortable && !disabled}
          onDragStart={() => setDragFrom(i)}
          onDragOver={(e) => { if (dragFrom !== null) { e.preventDefault(); setDragOver(i); } }}
          onDrop={() => { if (dragFrom !== null) move(dragFrom, i); setDragFrom(null); setDragOver(null); }}
          onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
          className={cn('flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-[var(--shadow-soft)]', dragOver === i && dragFrom !== i && 'border-brand-500 bg-brand-50')}
        >
          {sortable && <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-400" aria-hidden="true" />}
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100"><FileIcon className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-900">{f.name}</p>
            <p className="text-xs text-slate-600">{formatBytes(f.size)}</p>
          </div>
          {sortable && (
            <>
              <Button size="sm" variant="ghost" aria-label={`Move ${f.name} up`} disabled={disabled || i === 0} onClick={() => move(i, i - 1)}><ArrowUp className="h-4 w-4" /></Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${f.name} down`} disabled={disabled || i === files.length - 1} onClick={() => move(i, i + 1)}><ArrowDown className="h-4 w-4" /></Button>
            </>
          )}
          <Button size="sm" variant="danger" aria-label={`Remove ${f.name}`} disabled={disabled} onClick={() => onChange(files.filter((_, k) => k !== i))}><X className="h-4 w-4" /></Button>
        </li>
      ))}
    </ul>
  );
}
