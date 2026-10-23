import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Select, TextInput } from '@/features/tools/fields';
import { cn } from '@/lib/utils';
import { isRedaction, type A, type Item, type Mode } from './model';
import { ADD_KINDS, describe, fields, labels, newItem, nudge, setField, type AddKind, type Arrow, type Style } from './keyboard';

interface Props {
  mode: Mode; pageNo: number; items: Item[]; selected: string | null; setSelected: (id: string | null) => void;
  commit: (next: Item[]) => void; style: Style; /** Index of an image chosen but not yet placed. */ pendingImage: number | null; newId: () => string; disabled?: boolean;
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * Everything the pointer tools do, without a pointer: add an item, choose it from a list, set where it is and how big it is (in
 * percent of the page) or nudge it with the arrow keys, edit its text, remove it. It edits the same items and the same undo
 * history as the mouse tools, and says what it did in a live region for screen readers.
 */
export function ItemsPanel({ mode, pageNo, items, selected, setSelected, commit, style, pendingImage, newId, disabled }: Props) {
  const kinds = ADD_KINDS.filter((k) => k.modes.includes(mode) && (k.id !== 'image' || pendingImage !== null));
  const [kind, setKind] = useState<AddKind>(kinds[0]?.id ?? 'rect');
  const [message, setMessage] = useState('');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const firstField = useRef<HTMLInputElement>(null);
  const focusNew = useRef(false);

  const pageItems = useMemo(() => items.filter((i) => i.page === pageNo), [items, pageNo]);
  const names = useMemo(() => labels(pageItems), [pageItems]);
  const sel = pageItems.find((i) => i.id === selected);
  const selName = sel ? names[pageItems.indexOf(sel)]! : '';
  const kindValid = kinds.some((k) => k.id === kind) ? kind : kinds[0]?.id;

  const geometry = sel ? JSON.stringify(fields(sel)) : '';
  useEffect(() => { setTyped({}); }, [selected, geometry, (sel as A | undefined)?.type === 'text' ? (sel as A & { text: string }).text : '']);
  useEffect(() => { if (focusNew.current && sel) { focusNew.current = false; firstField.current?.focus(); } }, [selected, sel]);

  const replace = (next: Item) => commit(items.map((i) => (i.id === next.id ? next : i)));

  const add = () => {
    if (!kindValid) return;
    const item = newItem(kindValid, pageNo, style, newId(), pendingImage ?? 0);
    const n = labels([...pageItems, item]).at(-1)!;
    commit([...items, item]); setSelected(item.id); focusNew.current = true;
    setMessage(`${n} added to page ${pageNo + 1}, ${describe(item)}. Use the fields, or the arrow keys on its entry in the list, to adjust it.`);
  };

  const remove = (item: Item, name: string) => {
    const idx = pageItems.indexOf(item);
    commit(items.filter((i) => i.id !== item.id));
    const next = pageItems[idx + 1] ?? pageItems[idx - 1];
    setSelected(next?.id ?? null);
    setMessage(`${name} removed.`);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const btn = (e.target as HTMLElement).closest('button[data-id]') as HTMLElement | null;
    if (!btn) return;
    const item = pageItems.find((i) => i.id === btn.dataset.id);
    if (!item || disabled) return;
    const name = names[pageItems.indexOf(item)]!;
    if (ARROWS.has(e.key)) {
      e.preventDefault();
      setSelected(item.id);
      const moved = nudge(item, e.key as Arrow, { big: e.shiftKey, resize: e.altKey });
      if (JSON.stringify(moved) === JSON.stringify(item)) return void setMessage(`${name} cannot go further ${e.altKey ? 'in that direction' : 'that way'}: ${describe(item)}.`);
      replace(moved);
      setMessage(`${name} ${e.altKey ? 'resized' : 'moved'}: ${describe(moved)}.`);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); e.stopPropagation(); // the page-wide Delete shortcut must not also act
      remove(item, name);
    }
  };

  const apply = (key: string) => {
    if (!sel) return;
    const raw = typed[key];
    if (raw === undefined) return;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) { setTyped(({ [key]: _k, ...rest }) => rest); return void setMessage('That is not a number, so the value was left as it was.'); }
    const next = setField(sel, key, n);
    if (JSON.stringify(next) === JSON.stringify(sel)) return void setTyped(({ [key]: _k, ...rest }) => rest);
    replace(next);
    setMessage(`${selName}: ${describe(next)}.`);
  };

  const text = sel && !isRedaction(sel) && sel.type === 'text' ? (sel as A & { text: string }) : null;

  return (
    <section aria-label="Keyboard and screen-reader controls" className="space-y-4 rounded-xl border border-slate-200 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Without a mouse</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Add items, choose them from the list, and set where they go in percent of the page. With an item chosen in the list, the arrow keys move it by 1% (hold Shift for 5%), Alt with the arrow keys changes its size, and Delete removes it.
          {mode === 'edit' && ' Freehand drawing needs a mouse, pen or touch; a line or rectangle can be placed from here.'}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="What to add"><Select value={kindValid} onChange={(e) => setKind(e.target.value as AddKind)} disabled={disabled}>{kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</Select></Field>
        <Button type="button" variant="secondary" onClick={add} disabled={disabled || !kindValid}><Plus className="h-4 w-4" />Add to page {pageNo + 1}</Button>
      </div>

      <div>
        <h3 id="items-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-600">Items on page {pageNo + 1}</h3>
        {pageItems.length === 0
          ? <p className="mt-1 text-sm text-slate-600">Nothing on this page yet.</p>
          : (
            <ul aria-labelledby="items-heading" className="mt-2 space-y-1" onKeyDown={onListKey}>
              {pageItems.map((i, n) => (
                <li key={i.id}>
                  <button type="button" data-id={i.id} aria-pressed={i.id === selected} disabled={disabled} onClick={() => setSelected(i.id)}
                    className={cn('w-full rounded-lg border px-3 py-2 text-left text-sm focus-visible:outline-2', i.id === selected ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50')}>
                    <span className="font-medium">{names[n]}</span>{isRedaction(i) ? '' : (i as A).type === 'text' ? <span className="text-slate-600"> “{((i as A & { text: string }).text).slice(0, 30)}”</span> : ''}
                    <span className="block text-xs text-slate-600">{describe(i)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>

      {sel && (
        <fieldset className="rounded-lg border border-slate-200 p-3" disabled={disabled}>
          <legend className="px-1 text-sm font-medium">Position and size of {selName}</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {fields(sel).map((f, n) => (
              <Field key={f.key} label={f.label}>
                <TextInput ref={n === 0 ? firstField : undefined} type="number" inputMode="decimal" min={0} max={100} step={1}
                  value={typed[f.key] ?? String(f.value)}
                  onChange={(e) => setTyped((t) => ({ ...t, [f.key]: e.target.value }))}
                  onBlur={() => apply(f.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(f.key); } }} />
              </Field>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-600">Press Enter or move to the next field to apply a value. It cannot go outside the page.</p>
          {text && (
            <div className="mt-3 max-w-md">
              <Field label="Text">
                <TextInput value={typed.text ?? text.text} maxLength={4000}
                  onChange={(e) => setTyped((t) => ({ ...t, text: e.target.value }))}
                  onBlur={() => { const v = typed.text; if (v === undefined || v === text.text) return; if (!v.trim()) { setTyped(({ text: _t, ...r }) => r); return void setMessage('Text cannot be empty, so it was left as it was.'); } replace({ ...text, text: v } as Item); setMessage(`${selName} now reads “${v.slice(0, 40)}”.`); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
              </Field>
            </div>
          )}
          <div className="mt-3"><Button type="button" size="sm" variant="secondary" onClick={() => remove(sel, selName)}><Trash2 className="h-4 w-4" />Remove {selName}</Button></div>
        </fieldset>
      )}

      <p role="status" aria-live="polite" className="min-h-5 text-xs text-slate-700">{message}</p>
    </section>
  );
}
