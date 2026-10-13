import { Link } from 'react-router-dom';
import { buttonClass } from '@/components/ui/button';
import { useSeo } from '@/hooks/useSeo';

export default function NotFound() {
  useSeo({ title: 'Page not found', description: 'The page you are looking for does not exist.', path: '/404', noindex: true });
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <p className="text-sm font-semibold text-brand-600">404</p>
      <h1 className="mt-2 text-3xl font-bold">Page not found</h1>
      <p className="mt-3 text-slate-600">We could not find that page or tool.</p>
      <div className="mt-6 flex justify-center gap-3">
        <Link to="/" className={buttonClass({ size: 'lg' })}>Go home</Link>
        <Link to="/tools" className={buttonClass({ size: 'lg', variant: 'secondary' })}>All tools</Link>
      </div>
    </div>
  );
}
