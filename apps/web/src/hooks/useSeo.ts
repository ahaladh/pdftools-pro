import { useEffect } from 'react';
import { BRAND, SITE_URL } from '@/lib/utils';

interface Seo {
  title: string;
  description: string;
  path: string;
  jsonLd?: object;
  noindex?: boolean;
}

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.content = content;
}

/** Per-route title, description, canonical, Open Graph and JSON-LD. */
export function useSeo({ title, description, path, jsonLd, noindex }: Seo) {
  useEffect(() => {
    const full = title.includes(BRAND) ? title : `${title} | ${BRAND}`;
    const url = `${SITE_URL}${path}`;
    document.title = full;
    setMeta('name', 'description', description);
    setMeta('name', 'robots', noindex ? 'noindex' : 'index,follow');
    setMeta('property', 'og:title', full);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:type', 'website');
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) { link = document.createElement('link'); link.rel = 'canonical'; document.head.appendChild(link); }
    link.href = url;
    const old = document.getElementById('ld-json');
    old?.remove();
    if (jsonLd) {
      const s = document.createElement('script');
      s.id = 'ld-json'; s.type = 'application/ld+json'; s.text = JSON.stringify(jsonLd);
      document.head.appendChild(s);
    }
    return () => document.getElementById('ld-json')?.remove();
  }, [title, description, path, jsonLd, noindex]);
}
