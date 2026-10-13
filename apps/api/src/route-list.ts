import type { Application } from 'express';

interface Layer { name?: string; route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] }; regexp?: RegExp }

/** Every "METHOD /full/path" the app answers, discovered from Express' router stack (used by the authorization-matrix test). */
export function listRoutes(app: Application): string[] {
  const out: string[] = [];
  const prefixOf = (re: RegExp | undefined) => {
    if (!re) return '';
    const src = re.source;
    if (src === '^\\/?(?=\\/|$)') return '';
    return src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
  };
  const walk = (stack: Layer[], prefix: string) => {
    for (const l of stack) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${l.route.path === '/' ? '' : l.route.path}` || '/');
      } else if (l.name === 'router' && l.handle?.stack) {
        walk(l.handle.stack, prefix + prefixOf(l.regexp));
      }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walk(((app as any)._router?.stack ?? []) as Layer[], '');
  return [...new Set(out)].sort();
}
