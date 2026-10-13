import type { ToolDefinition } from '@pdftools/shared';

const EXT: Record<string, string[]> = { pdf: ['.pdf'], jpg: ['.jpg', '.jpeg'], png: ['.png'], office: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'] };
const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', office: '' };

export const acceptAttr = (t: ToolDefinition) => t.accept.flatMap((a) => [...(EXT[a] ?? []), MIME[a] ?? '']).join(',');
export const acceptLabel = (t: ToolDefinition) => t.accept.map((a) => (a === 'office' ? 'DOC, DOCX, XLS, XLSX, PPT, PPTX' : a.toUpperCase())).join(', ');

/** Client-side check for fast feedback. The server re-validates by file signature. */
export function validateFile(f: File, tool: ToolDefinition, maxBytes: number): string | null {
  const name = f.name.toLowerCase();
  const okType = tool.accept.some((a) => EXT[a]?.some((e) => name.endsWith(e)) || (MIME[a] !== '' && f.type === MIME[a]));
  if (!okType) return `"${f.name}" is not a supported file (accepted: ${acceptLabel(tool)}).`;
  if (f.size === 0) return `"${f.name}" is empty.`;
  if (f.size > maxBytes) return `"${f.name}" is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`;
  return null;
}
