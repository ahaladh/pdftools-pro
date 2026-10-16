import type { ToolCategory } from '@pdftools/shared';

/** One accent per tool category, used for icon tiles. Text colours are the 700 shade so they pass AA on the 50 tint. */
export const CATEGORY_STYLE: Record<ToolCategory, { tile: string; ring: string; dot: string }> = {
  organize: { tile: 'bg-indigo-50 text-indigo-700 ring-indigo-100', ring: 'group-hover:ring-indigo-200', dot: 'bg-indigo-500' },
  edit: { tile: 'bg-violet-50 text-violet-700 ring-violet-100', ring: 'group-hover:ring-violet-200', dot: 'bg-violet-500' },
  convert: { tile: 'bg-sky-50 text-sky-700 ring-sky-100', ring: 'group-hover:ring-sky-200', dot: 'bg-sky-500' },
  compress: { tile: 'bg-emerald-50 text-emerald-700 ring-emerald-100', ring: 'group-hover:ring-emerald-200', dot: 'bg-emerald-500' },
  security: { tile: 'bg-rose-50 text-rose-700 ring-rose-100', ring: 'group-hover:ring-rose-200', dot: 'bg-rose-500' },
  more: { tile: 'bg-amber-50 text-amber-800 ring-amber-100', ring: 'group-hover:ring-amber-200', dot: 'bg-amber-500' },
};
