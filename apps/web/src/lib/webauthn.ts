import { ApiError } from '@/lib/api';

/** The browser library is loaded only when a key is actually used, so it is not part of the main bundle. */
const lib = () => import('@simplewebauthn/browser');

export async function keysSupported(): Promise<boolean> {
  try { return (await lib()).browserSupportsWebAuthn(); } catch { return false; }
}

export async function askForKey(optionsJSON: unknown): Promise<unknown> {
  return (await lib()).startAuthentication({ optionsJSON: optionsJSON as never });
}
export async function createKey(optionsJSON: unknown): Promise<unknown> {
  return (await lib()).startRegistration({ optionsJSON: optionsJSON as never });
}

/** What to tell the user. A cancelled prompt is not an error worth alarming anyone about. */
export function keyErrorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const name = (e as { name?: string })?.name ?? '';
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'That security key is already registered on your account.';
  if (name === 'NotAllowedError' || code === 'ERROR_CEREMONY_ABORTED') return 'The security key prompt was cancelled or timed out. Try again.';
  if (name === 'SecurityError') return 'This site cannot use security keys here (it needs a secure https:// address).';
  if (name === 'InvalidStateError') return 'That security key is already registered on your account.';
  if (name === 'NotSupportedError') return 'Your browser or device cannot use security keys.';
  return e instanceof Error && e.message ? 'The security key could not be used. Try again, or use another sign-in method.' : 'Something went wrong with the security key.';
}
