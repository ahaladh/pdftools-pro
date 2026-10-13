import { Link } from 'react-router-dom';
import { BRAND } from '@/lib/utils';

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold text-slate-900" aria-label={`${BRAND} home`}>
      <img src="/favicon.svg" alt="" className="h-8 w-8" width={32} height={32} />
      <span className="text-lg">{BRAND}</span>
    </Link>
  );
}
