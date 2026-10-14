import { z } from 'zod';

/**
 * Document model for the editor. Every coordinate is a fraction (0..1) of the page *as displayed*
 * (after /Rotate), origin top-left. That makes annotations independent of zoom level and lets the
 * server map them onto rotated pages. Sizes (fontSize, widths) are in PDF points.
 */
const frac = z.number().min(0).max(1);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const base = { page: z.number().int().min(0).max(100000), id: z.string().max(64).optional() };
const box = { x: frac, y: frac, w: frac, h: frac };

export const FONTS = ['helvetica', 'times', 'courier'] as const;

export const annotationSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('text'), ...box, text: z.string().min(1).max(4000), fontSize: z.number().min(4).max(200), color, font: z.enum(FONTS).default('helvetica') }),
  z.object({ ...base, type: z.literal('rect'), ...box, stroke: color.nullable(), fill: color.nullable(), strokeWidth: z.number().min(0).max(40), opacity: z.number().min(0.05).max(1) }),
  z.object({ ...base, type: z.literal('ellipse'), ...box, stroke: color.nullable(), fill: color.nullable(), strokeWidth: z.number().min(0).max(40), opacity: z.number().min(0.05).max(1) }),
  z.object({ ...base, type: z.literal('highlight'), ...box, color, opacity: z.number().min(0.05).max(1) }),
  z.object({ ...base, type: z.literal('line'), x1: frac, y1: frac, x2: frac, y2: frac, color, strokeWidth: z.number().min(0.25).max(40), opacity: z.number().min(0.05).max(1) }),
  z.object({ ...base, type: z.literal('draw'), points: z.array(z.tuple([frac, frac])).min(2).max(5000), color, strokeWidth: z.number().min(0.25).max(40), opacity: z.number().min(0.05).max(1) }),
  /** imageIndex refers to the n-th image file sent after the PDF in the same request. */
  z.object({ ...base, type: z.literal('image'), ...box, imageIndex: z.number().int().min(0).max(50), opacity: z.number().min(0.05).max(1) }),
]);
export type Annotation = z.infer<typeof annotationSchema>;

export const annotationsOptions = z.object({
  annotations: z.array(annotationSchema).min(1, 'Add at least one annotation').max(2000),
});

export const redactionSchema = z.object({ page: z.number().int().min(0).max(100000), ...box });
export type Redaction = z.infer<typeof redactionSchema>;

export const redactOptions = z.object({
  redactions: z.array(redactionSchema).max(2000).default([]),
  /** Words or phrases to find in the PDF's text layer and redact wherever they appear. Plain text, not patterns. */
  search: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  caseSensitive: z.boolean().default(false),
  /** Resolution for the pages that get rasterized; higher is sharper but larger. */
  dpi: z.coerce.number().int().min(72).max(300).default(150),
}).refine((o) => o.redactions.length > 0 || o.search.length > 0, { message: 'Mark at least one area to redact or enter text to find' });

/** Edits to content that is already in the PDF. Boxes are page fractions (0..1) as displayed, origin top-left. */
export const textEditSchema = z.object({
  page: z.number().int().min(0).max(100000), ...box,
  /** What the client believes is under the box; used only to warn if the file disagrees. */
  original: z.string().max(2000).optional(),
  /** New text. Empty deletes the text. */
  replacement: z.string().max(2000),
  font: z.enum(['auto', ...FONTS]).default('auto'),
  bold: z.boolean().nullable().optional(),
  italic: z.boolean().nullable().optional(),
  size: z.number().min(2).max(300).nullable().optional(),
  color: color.nullable().optional(),
});
export const imageEditSchema = z.object({
  page: z.number().int().min(0).max(100000), ...box,
  action: z.enum(['delete', 'replace']),
  /** For `replace`: index of the n-th image file sent after the PDF. */
  imageIndex: z.number().int().min(0).max(50).optional(),
  fit: z.enum(['contain', 'stretch']).default('contain'),
}).refine((e) => e.action === 'delete' || e.imageIndex !== undefined, { message: 'Choose a replacement image' });

export const editContentOptions = z.object({
  textEdits: z.array(textEditSchema).max(500).default([]),
  imageEdits: z.array(imageEditSchema).max(200).default([]),
}).refine((o) => o.textEdits.length + o.imageEdits.length > 0, { message: 'Change at least one piece of text or one image' });
export type EditContentOptions = z.infer<typeof editContentOptions>;
export type TextEdit = z.infer<typeof textEditSchema>;
export type ImageEdit = z.infer<typeof imageEditSchema>;
