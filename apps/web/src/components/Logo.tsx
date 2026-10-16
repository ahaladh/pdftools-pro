import { Link } from 'react-router-dom';
import { BRAND, cn } from '@/lib/utils';

/** Brand mark: a gradient tile with a folded page. Inline so it themes with the page and costs no request. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-8 w-8 shrink-0', className)} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="lm-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stopColor="#6366f1" /><stop offset="1" stopColor="#7c3aed" /></linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lm-g)" />
      <path d="M10 7.5h8.2L23 12.3V24a.5.5 0 0 1-.5.5h-12a.5.5 0 0 1-.5-.5z" fill="#fff" />
      <path d="M18.2 7.5v4.1a.7.7 0 0 0 .7.7H23z" fill="#c7d2fe" />
      <path d="M12.5 17h7M12.5 20h4.5" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ onDark }: { onDark?: boolean }) {
  return (
    <Link to="/" className={cn('flex items-center gap-2.5 font-semibold tracking-tight', onDark ? 'text-white' : 'text-slate-900')} aria-label={`${BRAND} home`}>
      <LogoMark />
      <span className="text-[1.05rem]">{BRAND}</span>
    </Link>
  );
}
