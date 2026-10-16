import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// These guard the deployment files against mistakes only a real build or a real server would otherwise reveal.
const ROOT = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('deployment files', () => {
  it('the web image uses the Playwright image that matches the installed playwright-core (a mismatch breaks the prerender step)', () => {
    const tag = /FROM mcr\.microsoft\.com\/playwright:v([\d.]+)-/.exec(read('infrastructure/docker/Dockerfile.web'))?.[1];
    const installed = (createRequire(join(ROOT, 'apps/web/package.json'))('playwright-core/package.json') as { version: string }).version;
    expect(tag).toBeDefined();
    expect(tag).toBe(installed);
    // and the version is pinned exactly, so a lockfile refresh cannot move it silently
    const declared = (JSON.parse(read('apps/web/package.json')).dependencies?.['playwright-core'] ?? JSON.parse(read('apps/web/package.json')).devDependencies?.['playwright-core']) as string;
    expect(declared).toBe(installed);
  });

  it('nginx templates only use syntax that works on the nginx shipped by Debian/Ubuntu LTS (<= 1.24)', () => {
    const dir = join(ROOT, 'infrastructure/nginx');
    const files = [...readdirSync(dir), ...readdirSync(join(dir, 'snippets')).map((f) => `snippets/${f}`)].filter((f) => /\.(conf|template)$/.test(f));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = read(`infrastructure/nginx/${f}`).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
      expect(text, `${f}: "http2 on;" needs nginx >= 1.25.1; use "listen ... ssl http2;"`).not.toMatch(/^\s*http2\s+on\s*;/m);
      expect(text, `${f}: "http3 on;" needs a QUIC-enabled nginx >= 1.25`).not.toMatch(/^\s*http3\s+on\s*;/m);
    }
    expect(existsSync(join(dir, 'pdftools-vps.conf.template'))).toBe(true);
  });
});
