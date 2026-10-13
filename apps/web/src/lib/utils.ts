import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export const BRAND = (import.meta.env.VITE_BRAND_NAME as string | undefined) ?? 'PDFTools Pro';
export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) ?? window.location.origin;
