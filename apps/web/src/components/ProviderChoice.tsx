import type { BillingProvider } from '@pdftools/shared';

export const PROVIDER_NAME: Record<BillingProvider, string> = { stripe: 'Stripe', razorpay: 'Razorpay' };
const HINT: Record<BillingProvider, string> = { stripe: 'Cards worldwide', razorpay: 'UPI, Indian cards, netbanking, international cards' };

/** Choose how to pay when the server offers more than one gateway. Renders nothing when there is nothing to choose. */
export function ProviderChoice({ providers, value, onChange, name = 'provider' }: { providers: BillingProvider[]; value: BillingProvider; onChange: (p: BillingProvider) => void; name?: string }) {
  if (providers.length < 2) return null;
  return (
    <fieldset className="mt-4 text-sm">
      <legend className="mb-1 font-medium text-slate-700">Pay with</legend>
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <label key={p} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${value === p ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white'}`}>
            <input type="radio" name={name} value={p} checked={value === p} onChange={() => onChange(p)} />
            <span><span className="font-medium">{PROVIDER_NAME[p]}</span> <span className="text-slate-600">· {HINT[p]}</span></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The gateway to use for a plan: the buyer's preference if that gateway can sell it, otherwise the first one that can. */
export function viaFor(preferred: BillingProvider, plan: { providers: BillingProvider[] }): BillingProvider | undefined {
  return plan.providers.includes(preferred) ? preferred : plan.providers[0];
}
