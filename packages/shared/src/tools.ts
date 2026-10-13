import { z } from 'zod';
import { annotationsOptions, redactOptions } from './annotations.js';

export type ToolCategory = 'organize' | 'edit' | 'convert' | 'compress' | 'security' | 'more';
export type ToolStatus = 'available' | 'planned';

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  organize: 'Organize PDF',
  edit: 'Edit PDF',
  convert: 'Convert PDF',
  compress: 'Compress PDF',
  security: 'Security & privacy',
  more: 'More tools',
};

export interface ToolDefinition {
  id: string;
  name: string;
  category: ToolCategory;
  short: string;
  description: string;
  status: ToolStatus;
  accept: ('pdf' | 'jpg' | 'png' | 'office')[];
  multiple: boolean;
  /** Minimum number of input files. */
  minFiles: number;
  /** Hard maximum number of input files (defaults to the global limit). */
  maxFiles?: number;
  popular?: boolean;
  /** Zod schema for the tool-specific options object. */
  options?: z.ZodTypeAny;
  faq: { q: string; a: string }[];
  related: string[];
}

const rangeStr = z.string().max(500);

export const optionSchemas = {
  merge: z.object({}).strict(),
  split: z.object({
    mode: z.enum(['ranges', 'every', 'each']).default('each'),
    ranges: rangeStr.default(''),
    every: z.coerce.number().int().min(1).max(10000).default(1),
  }),
  compress: z.object({
    preset: z.enum(['maximum-quality', 'recommended', 'maximum-compression']).default('recommended'),
    stripMetadata: z.boolean().default(false),
  }),
  rotate: z.object({
    angle: z.union([z.literal(90), z.literal(180), z.literal(270)]).default(90),
    pages: rangeStr.default('all'),
  }),
  organize: z.object({
    /** 1-based page sequence, e.g. "3,1,2,2". Pages left out are deleted. */
    order: z.string().min(1).max(20000),
    rotations: z.record(z.string(), z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])).default({}),
  }),
  'extract-pages': z.object({ pages: rangeStr.min(1) }),
  'page-numbers': z.object({
    position: z.enum(['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-left', 'top-right']).default('bottom-center'),
    start: z.coerce.number().int().min(0).max(100000).default(1),
    format: z.enum(['n', 'page-n', 'n-of-total']).default('n'),
    fontSize: z.coerce.number().min(6).max(48).default(11),
    pages: rangeStr.default('all'),
  }),
  watermark: z.object({
    text: z.string().min(1).max(100),
    opacity: z.coerce.number().min(0.05).max(1).default(0.25),
    fontSize: z.coerce.number().min(8).max(200).default(60),
    rotation: z.coerce.number().min(-90).max(90).default(45),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#888888'),
    pages: rangeStr.default('all'),
  }),
  'images-to-pdf': z.object({
    pageSize: z.enum(['fit', 'a4', 'letter']).default('fit'),
    margin: z.coerce.number().min(0).max(100).default(0),
  }),
  'pdf-to-images': z.object({
    format: z.enum(['png', 'jpg']).default('jpg'),
    dpi: z.coerce.number().int().min(36).max(300).default(150),
    pages: rangeStr.default('all'),
  }),
  'office-to-pdf': z.object({}).strict(),
  protect: z.object({
    password: z.string().min(1).max(128),
    ownerPassword: z.string().max(128).optional(),
  }),
  unlock: z.object({
    password: z.string().min(1).max(128),
    /** The user must affirm they are entitled to open this document. */
    confirmAuthorized: z.literal(true, { errorMap: () => ({ message: 'Please confirm you are authorized to open this document' }) }),
  }),
  'pdf-to-text': z.object({}).strict(),
  'pdf-to-html': z.object({}).strict(),
  'extract-images': z.object({}).strict(),
  crop: z.object({
    top: z.coerce.number().min(0).max(90).default(0),
    right: z.coerce.number().min(0).max(90).default(0),
    bottom: z.coerce.number().min(0).max(90).default(0),
    left: z.coerce.number().min(0).max(90).default(0),
    pages: rangeStr.default('all'),
  }),
  resize: z.object({
    size: z.enum(['a3', 'a4', 'a5', 'letter', 'legal']).default('a4'),
    pages: rangeStr.default('all'),
  }),
  'add-blank-pages': z.object({
    count: z.coerce.number().int().min(1).max(100).default(1),
    /** Insert after this 1-based page; 0 = at the start; omitted = at the end. */
    after: z.coerce.number().int().min(0).max(100000).optional(),
  }),
  flatten: z.object({}).strict(),
  compare: z.object({}).strict(),
  repair: z.object({}).strict(),
  edit: annotationsOptions,
  sign: annotationsOptions,
  redact: redactOptions,
} as const;

export type ToolId = keyof typeof optionSchemas;
export type ToolOptions<T extends ToolId> = z.infer<(typeof optionSchemas)[T]>;

const relatedDefault = ['merge', 'split', 'compress'];

export const TOOLS: ToolDefinition[] = [
  {
    id: 'merge', name: 'Merge PDF', category: 'organize', status: 'available', popular: true,
    short: 'Combine several PDFs into one document.',
    description: 'Upload two or more PDF files, drag them into the order you want, and download a single merged PDF.',
    accept: ['pdf'], multiple: true, minFiles: 2, options: optionSchemas.merge,
    faq: [
      { q: 'Is the order of my files preserved?', a: 'Yes. Files are merged in the order shown in the list; drag to change it before merging.' },
      { q: 'Are bookmarks and form fields kept?', a: 'Pages are copied as-is. Document-level bookmarks and interactive form data from the source files are not carried over.' },
    ],
    related: ['split', 'organize', 'compress'],
  },
  {
    id: 'split', name: 'Split PDF', category: 'organize', status: 'available', popular: true,
    short: 'Split a PDF by page ranges or into single pages.',
    description: 'Split by custom ranges, every N pages, or into one file per page. Multiple results are delivered as a ZIP.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas.split,
    faq: [{ q: 'How are results delivered?', a: 'A single result is a PDF; several results are bundled into a ZIP archive.' }],
    related: ['extract-pages', 'organize', 'merge'],
  },
  {
    id: 'compress', name: 'Compress PDF', category: 'compress', status: 'available', popular: true,
    short: 'Reduce PDF file size with selectable quality.',
    description: 'Re-optimizes images and structure using Ghostscript. The size reduction depends entirely on your file and is shown after processing.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas.compress,
    faq: [
      { q: 'How much smaller will my file be?', a: 'It depends on the content. Files that are already optimized, or mostly text, may shrink very little. Results are reported after processing. If the output would be larger, the original is returned.' },
      { q: 'Will text stay selectable?', a: 'Yes for the Recommended and Maximum quality presets; text and vectors are not rasterized.' },
    ],
    related: ['merge', 'split', 'pdf-to-images'],
  },
  {
    id: 'rotate', name: 'Rotate PDF', category: 'organize', status: 'available', popular: true,
    short: 'Rotate all or selected pages.',
    description: 'Rotate every page, or only specific pages and ranges, by 90, 180 or 270 degrees.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas.rotate,
    faq: [{ q: 'Can I rotate only some pages?', a: 'Yes, enter page numbers or ranges such as 1-3, 7.' }],
    related: ['organize', 'extract-pages', 'merge'],
  },
  {
    id: 'organize', name: 'Organize PDF', category: 'organize', status: 'available',
    short: 'Delete, reorder, duplicate and rotate pages.',
    description: 'Arrange pages visually: drag to reorder, remove pages you do not need, duplicate pages and rotate them individually.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas.organize,
    faq: [{ q: 'How do I delete a page?', a: 'Remove its thumbnail from the grid. Pages not in the final order are dropped.' }],
    related: ['rotate', 'extract-pages', 'split'],
  },
  {
    id: 'extract-pages', name: 'Extract PDF pages', category: 'organize', status: 'available',
    short: 'Pull selected pages into a new PDF.',
    description: 'Choose pages and ranges to keep and get a new PDF containing only those pages.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['extract-pages'],
    faq: [{ q: 'What range syntax is supported?', a: 'Comma-separated pages and ranges, e.g. 1-3, 5, 8-. An open range runs to the last page.' }],
    related: relatedDefault, 
  },
  {
    id: 'page-numbers', name: 'Add page numbers', category: 'edit', status: 'available',
    short: 'Stamp page numbers onto your PDF.',
    description: 'Choose position, starting number, format and font size. Numbers are added as new text; existing content is untouched.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['page-numbers'],
    faq: [], related: ['watermark', 'merge', 'organize'],
  },
  {
    id: 'watermark', name: 'Add watermark', category: 'edit', status: 'available', popular: true,
    short: 'Overlay a text watermark on pages.',
    description: 'Add a diagonal or straight text watermark with adjustable opacity, size and colour. Text-only; image watermarks are planned.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas.watermark,
    faq: [{ q: 'Is the watermark removable?', a: 'It is added as page content, not as a flattened image, so a determined user with PDF editing tools may be able to remove it. Do not rely on it for security.' }],
    related: ['page-numbers', 'merge', 'compress'],
  },
  {
    id: 'images-to-pdf', name: 'JPG / PNG to PDF', category: 'convert', status: 'available', popular: true,
    short: 'Turn images into a PDF.',
    description: 'Combine JPG and PNG images into one PDF, one image per page, with optional page size and margin.',
    accept: ['jpg', 'png'], multiple: true, minFiles: 1, options: optionSchemas['images-to-pdf'],
    faq: [{ q: 'Which formats are supported?', a: 'JPEG and PNG. Progressive/CMYK JPEGs and interlaced PNGs may be rejected with a clear error.' }],
    related: ['pdf-to-images', 'merge', 'compress'],
  },
  {
    id: 'pdf-to-images', name: 'PDF to JPG / PNG', category: 'convert', status: 'available', popular: true,
    short: 'Render PDF pages as images.',
    description: 'Render pages to JPG or PNG at your chosen resolution using Poppler. Multiple pages are delivered as a ZIP.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['pdf-to-images'],
    faq: [{ q: 'What resolution should I choose?', a: '150 DPI suits screens; use 300 DPI for print. Higher values take longer and produce larger files.' }],
    related: ['images-to-pdf', 'compress', 'split'],
  },
  {
    id: 'office-to-pdf', name: 'Word, Excel, PowerPoint to PDF', category: 'convert', status: 'available', popular: true,
    short: 'Convert Office documents to PDF.', description: 'Converts DOC/DOCX, XLS/XLSX and PPT/PPTX to PDF with LibreOffice. Layout fidelity depends on fonts and features used; complex documents may differ from Microsoft Office rendering.',
    accept: ['office'], multiple: false, minFiles: 1, options: optionSchemas['office-to-pdf'],
    faq: [{ q: 'Will it look identical to Word?', a: 'Not always. LibreOffice renders the file, so unusual fonts, SmartArt, macros and advanced layouts may differ. Check the result before sharing.' }, { q: 'Are macros run?', a: 'No. Documents are converted headlessly in an isolated work directory and macros are not executed.' }], related: ['merge', 'compress', 'pdf-to-images'],
  },
  {
    id: 'protect', name: 'Protect PDF', category: 'security', status: 'available',
    short: 'Encrypt a PDF with a password.', description: 'Encrypts your PDF so a password is required to open it. Choose a strong password: we cannot recover it for you.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['protect'],
    faq: [{ q: 'Do you store my password?', a: 'The password is used only to encrypt the file and is removed from the job record when processing ends. It is never logged.' }], related: ['unlock', 'watermark', 'compress'],
  },
  {
    id: 'unlock', name: 'Unlock PDF', category: 'security', status: 'available',
    short: 'Remove the password from a PDF you can open.', description: 'Removes password protection from a PDF when you supply the correct password. We cannot and do not bypass encryption without the password.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['unlock'],
    faq: [{ q: 'Can you crack a forgotten password?', a: 'No. This tool only works when you provide the correct password and are entitled to open the document.' }], related: ['protect', 'merge', 'compress'],
  },
  {
    id: 'pdf-to-text', name: 'PDF to text', category: 'convert', status: 'available',
    short: 'Extract text from a PDF.', description: 'Extracts the text layer using Poppler, preserving reading layout where possible. Scanned PDFs have no text layer and will produce little or no output.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['pdf-to-text'],
    faq: [], related: ['pdf-to-html', 'extract-images', 'compare'],
  },
  {
    id: 'pdf-to-html', name: 'PDF to HTML', category: 'convert', status: 'available',
    short: 'Convert PDF pages to HTML.', description: 'Converts PDF to HTML using Poppler. Output is positioned text per page, so complex layouts are approximated rather than reflowed.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['pdf-to-html'],
    faq: [], related: ['pdf-to-text', 'pdf-to-images', 'compress'],
  },
  {
    id: 'extract-images', name: 'Extract images from PDF', category: 'more', status: 'available',
    short: 'Download embedded images.', description: 'Extracts the images embedded in a PDF in their original format where possible. Vector artwork and rendered text are not images and are not extracted; use PDF to JPG for page renders.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['extract-images'],
    faq: [], related: ['pdf-to-images', 'pdf-to-text', 'compress'],
  },
  {
    id: 'crop', name: 'Crop PDF', category: 'organize', status: 'available',
    short: 'Trim margins from pages.', description: 'Crop by percentage from each edge for all or selected pages. This sets the visible area; hidden content is not deleted from the file.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['crop'],
    faq: [{ q: 'Is cropped content removed?', a: 'No. Cropping changes the visible page box only. Use Redact to permanently remove content.' }], related: ['resize', 'rotate', 'organize'],
  },
  {
    id: 'resize', name: 'Resize PDF pages', category: 'organize', status: 'available',
    short: 'Fit pages to a standard paper size.', description: 'Scales each page to fit A3, A4, A5, Letter or Legal, centred with aspect ratio preserved. Links, form fields and annotations are not carried over.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['resize'],
    faq: [], related: ['crop', 'rotate', 'merge'],
  },
  {
    id: 'add-blank-pages', name: 'Add blank pages', category: 'organize', status: 'available',
    short: 'Insert empty pages.', description: 'Insert one or more blank pages at the start, end, or after a chosen page.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['add-blank-pages'],
    faq: [], related: ['organize', 'merge', 'page-numbers'],
  },
  {
    id: 'flatten', name: 'Flatten form fields', category: 'security', status: 'available',
    short: 'Make form fields permanent.', description: 'Turns fillable form fields into static page content so they can no longer be edited. Other annotation types are not flattened by this tool.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['flatten'],
    faq: [], related: ['protect', 'compress', 'merge'],
  },
  {
    id: 'compare', name: 'Compare PDFs', category: 'more', status: 'available',
    short: 'Find text differences between two PDFs.', description: 'Compares the extracted text of two PDFs and produces an HTML report of added and removed lines. This is a text comparison; visual and layout-only differences are not detected.',
    accept: ['pdf'], multiple: true, minFiles: 2, maxFiles: 2, options: optionSchemas['compare'],
    faq: [], related: ['pdf-to-text', 'merge', 'split'],
  },
  {
    id: 'repair', name: 'Repair PDF', category: 'more', status: 'available',
    short: 'Try to recover a damaged PDF.', description: 'Rewrites the file with Ghostscript, which can recover many PDFs with broken cross-reference tables or truncated endings. Recovery is best-effort; severely damaged files may be unrecoverable.',
    accept: ['pdf'], multiple: false, minFiles: 1, options: optionSchemas['repair'],
    faq: [], related: ['compress', 'merge', 'pdf-to-text'],
  },
  {
    id: 'edit', name: 'Edit PDF', category: 'edit', status: 'available', popular: true,
    short: 'Add text, shapes, highlights, drawings and images.', description: 'Add new content on top of your PDF: text, rectangles, ellipses, lines, highlights, freehand drawing and images. This adds new content; it does not edit the existing text inside the PDF.',
    accept: ['pdf', 'jpg', 'png'], multiple: true, minFiles: 1, options: optionSchemas['edit'],
    faq: [{ q: 'Can I edit the existing text in my PDF?', a: 'Not yet. This editor adds new text, shapes and images on top of pages. Changing text that is already part of the document is not supported.' }, { q: 'Does highlight select text?', a: 'No. The highlight tool draws a translucent colour box. It is not tied to the underlying text.' }, { q: 'What fonts are available?', a: 'Helvetica, Times and Courier (standard PDF fonts), Latin characters only.' }], related: ['sign', 'redact', 'watermark'],
  },
  {
    id: 'sign', name: 'Sign PDF', category: 'more', status: 'available',
    short: 'Place a drawn or uploaded signature image.', description: 'Draw or upload a signature and place it on any page. This creates a visual signature only: it is not a certificate-based digital signature and has no cryptographic validation or tamper evidence.',
    accept: ['pdf', 'jpg', 'png'], multiple: true, minFiles: 1, options: optionSchemas['sign'],
    faq: [{ q: 'Is this a legally valid digital signature?', a: 'It is an image of a signature (an electronic signature in the broad sense). It is not a certificate-based digital signature (PAdES) and carries no cryptographic proof of identity or integrity. Whether it is sufficient depends on your jurisdiction and use case.' }], related: ['edit', 'protect', 'flatten'],
  },
  {
    id: 'redact', name: 'Redact PDF', category: 'security', status: 'available',
    short: 'Permanently remove sensitive areas.', description: 'Draw boxes over sensitive content. Pages with redactions are re-rendered as images with the boxes burned in, so the covered text and graphics are removed from the file, not just hidden. Redacted pages lose their selectable text.',
    accept: ['pdf', 'jpg', 'png'], multiple: true, minFiles: 1, options: optionSchemas['redact'],
    faq: [{ q: 'Is the hidden content really gone?', a: 'Yes. Redacted pages are rasterized with the black boxes burned into the pixels and the original page content is discarded, so the text cannot be recovered from the file. Pages you did not redact are kept as they were.' }, { q: 'Why is text on redacted pages no longer selectable?', a: 'Because those pages become images. OCR is not available yet to restore a text layer.' }, { q: 'What about metadata?', a: 'The output is a new document: original metadata, bookmarks and attachments are not carried over.' }], related: ['protect', 'flatten', 'compress'],
  },
];

/** Tools on the roadmap. Shown in the directory as "coming soon", never as working. */
const planned = (id: string, name: string, category: ToolCategory, short: string): ToolDefinition => ({
  id, name, category, short, description: short, status: 'planned', accept: ['pdf'], multiple: false, minFiles: 1, faq: [], related: [],
});
export const PLANNED_TOOLS: ToolDefinition[] = [
  planned('pdf-to-word', 'PDF to Word', 'convert', 'Convert PDF to editable DOCX.'),
  planned('ocr', 'OCR PDF', 'more', 'Make scanned PDFs searchable (needs Tesseract).'),
  planned('pdf-to-excel', 'PDF to Excel', 'convert', 'Extract tables to XLSX.'),
  planned('pdf-to-powerpoint', 'PDF to PowerPoint', 'convert', 'Convert PDF to PPTX.'),
  planned('pdf-to-pdfa', 'PDF to PDF/A', 'convert', 'Archival PDF (needs a validator before we can claim compliance).'),
  planned('fill-forms', 'Fill PDF forms', 'edit', 'Fill AcroForm fields.'),
];

export const ALL_TOOLS = [...TOOLS, ...PLANNED_TOOLS];
export const getTool = (id: string) => ALL_TOOLS.find((t) => t.id === id);
export const isToolId = (id: string): id is ToolId => id in optionSchemas;
