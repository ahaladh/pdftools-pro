// Emits sitemap.xml and robots.txt from the shared tool registry. Run automatically before build.
import { writeFileSync, mkdirSync } from 'node:fs';
import { TOOLS } from '@pdftools/shared';

const site = (process.env.SITE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const urls = ['/', '/tools', '/pricing', '/privacy', '/terms', ...TOOLS.map((t) => `/${t.id}`)];
mkdirSync('public', { recursive: true });
writeFileSync('public/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${site}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync('public/robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${site}/sitemap.xml\n`);
console.log(`SEO files written for ${site} (${urls.length} urls)`);
