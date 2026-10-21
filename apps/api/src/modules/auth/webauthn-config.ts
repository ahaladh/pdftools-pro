import type { Env } from '../../config/env.js';

export interface RelyingParty { rpID: string; rpName: string; origins: string[] }

/** The relying party: what a key is bound to forever. Derived from PUBLIC_URL unless overridden. Throws if PUBLIC_URL is not a URL. */
export function webauthnConfig(env: Env): RelyingParty {
  const url = new URL(env.PUBLIC_URL);
  const origins = env.WEBAUTHN_ORIGINS ? env.WEBAUTHN_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : [url.origin];
  return { rpID: env.WEBAUTHN_RP_ID?.trim() || url.hostname, rpName: env.BRAND_NAME, origins };
}

/**
 * Problems that make security keys unusable, in plain words (empty when fine). Browsers only offer WebAuthn on https
 * (localhost excepted), and the RP ID must be the site's host or a parent domain of it.
 */
export function webauthnProblems(cfg: RelyingParty): string[] {
  const out: string[] = [];
  for (const o of cfg.origins) {
    let u: URL;
    try { u = new URL(o); } catch { out.push(`"${o}" is not a valid origin`); continue; }
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') out.push(`${o} is not https: browsers will not offer security keys there`);
    if (u.hostname !== cfg.rpID && !u.hostname.endsWith(`.${cfg.rpID}`)) out.push(`RP ID "${cfg.rpID}" is not ${u.hostname} or a parent domain of it: keys could never be used on ${o}`);
  }
  return out;
}
