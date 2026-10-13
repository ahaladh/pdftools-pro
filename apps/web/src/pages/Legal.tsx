import { useSeo } from '@/hooks/useSeo';
import { BRAND } from '@/lib/utils';

export function Privacy() {
  useSeo({ title: 'Privacy policy', description: 'How uploaded files and data are handled, stored and deleted.', path: '/privacy' });
  return (
    <article className="prose mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold">Privacy policy</h1>
      <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Operator note: this is a technical description of how the software behaves. Have it reviewed by counsel and adapt it to your jurisdiction before launch.</p>
      <h2 className="mt-6 text-xl font-semibold">What we process</h2>
      <p className="mt-2 text-slate-700">{BRAND} processes the files you upload solely to perform the tool you select. We do not read, index or share document contents.</p>
      <h2 className="mt-6 text-xl font-semibold">Storage and deletion</h2>
      <p className="mt-2 text-slate-700">Uploads are written to private storage not reachable by public URL. Original uploads are deleted when processing ends. Results are deleted automatically after the retention period shown on each tool page, or immediately if you choose “Delete now”.</p>
      <h2 className="mt-6 text-xl font-semibold">Accounts</h2>
      <p className="mt-2 text-slate-700">If you create an account we store your email, optional name, a salted hash of your password (never the password), your plan, and per-day usage counts. Job history keeps tool names and status, not document contents. Payments are processed by Stripe; we store only Stripe customer and subscription identifiers. Deleting your account removes this data and any stored results.</p>
      <h2 className="mt-6 text-xl font-semibold">Identifiers and logs</h2>
      <p className="mt-2 text-slate-700">A random, httpOnly session cookie links your browser to your own jobs. Server logs record job identifiers, tool names and status — never file contents or filenames.</p>
    </article>
  );
}

export function Terms() {
  useSeo({ title: 'Terms of service', description: 'Terms of service for the online PDF tools: acceptable use, limits, availability and your responsibilities.', path: '/terms' });
  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold">Terms of service</h1>
      <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Operator note: placeholder terms. Replace with legally reviewed terms before launch.</p>
      <p className="mt-4 text-slate-700">You may only upload documents you have the right to process. The service is provided as is, without warranty. Do not use it to process content that is unlawful. Do not attempt to bypass limits or interfere with the service.</p>
    </article>
  );
}
