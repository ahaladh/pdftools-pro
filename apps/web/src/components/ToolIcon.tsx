import { Combine, Scissors, Minimize2, RotateCw, LayoutGrid, FileOutput, Hash, Droplets, ImagePlus, Images, FileText, Lock, Unlock, Crop, Maximize2, FilePlus, Layers, GitCompare, Wrench, FileCode, ImageDown, FileType, type LucideIcon } from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  merge: Combine, split: Scissors, compress: Minimize2, rotate: RotateCw, organize: LayoutGrid,
  'extract-pages': FileOutput, 'page-numbers': Hash, watermark: Droplets, 'images-to-pdf': ImagePlus, 'pdf-to-images': Images,
  'office-to-pdf': FileType, protect: Lock, unlock: Unlock, 'pdf-to-text': FileText, 'pdf-to-html': FileCode, 'extract-images': ImageDown,
  crop: Crop, resize: Maximize2, 'add-blank-pages': FilePlus, flatten: Layers, compare: GitCompare, repair: Wrench,
};

export function ToolIcon({ id, className }: { id: string; className?: string }) {
  const Icon = ICONS[id] ?? FileText;
  return <Icon className={className} aria-hidden="true" />;
}
