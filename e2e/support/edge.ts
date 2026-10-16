import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT } from './stack';

export const NGINX = process.env.NGINX_BIN ?? [join(homedir(), '.cache/pdftools/nginx/sbin/nginx'), '/usr/sbin/nginx', '/usr/local/nginx/sbin/nginx'].find(existsSync);

export interface Edge { httpsUrl: string; httpUrl: string; accessLog: string; errorLog: string; conf: string; dir: string; test: () => string; stop: () => void }

/** Start a real nginx with the rendered production template in front of `apiAddr`, with a throwaway self-signed certificate. */
export function startEdge(opts: { apiAddr: string; httpPort: number; httpsPort: number; webRoot?: string }): Edge {
  if (!NGINX) throw new Error('no nginx binary found (set NGINX_BIN)');
  const dir = mkdtempSync(join(tmpdir(), 'edge-'));
  for (const d of ['body', 'proxy', 'fcgi', 'uwsgi', 'scgi', 'logs']) mkdirSync(join(dir, d));
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const accessLog = join(dir, 'access.log'), errorLog = join(dir, 'error.log');
  const rendered = execFileSync('bash', [join(ROOT, 'infrastructure/nginx/render.sh')], {
    env: { PATH: process.env.PATH!, DOMAIN: 'localhost', WEB_ROOT: opts.webRoot ?? join(ROOT, 'apps/web/dist'), API_ADDR: opts.apiAddr, CERT: cert, KEY: key,
      SNIPPETS: join(ROOT, 'infrastructure/nginx/snippets'), HTTP_PORT: String(opts.httpPort), HTTPS_PORT: String(opts.httpsPort), ACCESS_LOG: accessLog },
  }).toString();
  const site = join(dir, 'site.conf'); writeFileSync(site, rendered);
  const mime = [join(dirname(NGINX), '../conf/mime.types'), '/etc/nginx/mime.types'].find(existsSync)!;
  const conf = join(dir, 'nginx.conf');
  writeFileSync(conf, `worker_processes 1;\npid ${dir}/nginx.pid;\nerror_log ${errorLog} info;\nevents { worker_connections 256; }\nhttp {\n  # Packaged nginx builds default to /var/log/nginx/access.log, which an unprivileged test run cannot open.\n  access_log ${dir}/default-access.log;\n  include ${mime};\n  default_type application/octet-stream;\n  client_body_temp_path ${dir}/body;\n  proxy_temp_path ${dir}/proxy;\n  fastcgi_temp_path ${dir}/fcgi;\n  uwsgi_temp_path ${dir}/uwsgi;\n  scgi_temp_path ${dir}/scgi;\n  include "${site}";\n}\n`);
  const args = ['-p', dir, '-c', conf];
  const test = () => { try { execFileSync(NGINX, [...args, '-t'], { stdio: 'pipe' }); return 'ok'; } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? e); } };
  const proc: ChildProcess = spawn(NGINX, [...args, '-g', 'daemon off;'], { stdio: 'ignore', detached: true });
  return {
    httpsUrl: `https://localhost:${opts.httpsPort}`, httpUrl: `http://localhost:${opts.httpPort}`, accessLog, errorLog, conf: site, dir, test,
    stop: () => { try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* gone */ } },
  };
}

const CADDY = process.env.CADDY_BIN ?? [join(homedir(), '.cache/pdftools/caddy/caddy'), '/usr/bin/caddy', '/usr/local/bin/caddy'].find(existsSync);
export { CADDY };

export interface Chain { httpsUrl: string; nginxUrl: string; accessLog: string; stop: () => void }

/**
 * The docker-compose TLS chain, for real: Caddy (infrastructure/caddy/Caddyfile, `tls internal` = self-signed) in front of nginx running
 * the CONTAINER config (infrastructure/nginx/default.conf, with only paths/ports rewritten for localhost) in front of the API.
 */
export function startChain(opts: { apiAddr: string; nginxPort: number; caddyPort: number; webRoot?: string }): Chain {
  if (!NGINX || !CADDY) throw new Error('nginx and caddy binaries are required (NGINX_BIN, CADDY_BIN)');
  const dir = mkdtempSync(join(tmpdir(), 'chain-'));
  for (const d of ['body', 'proxy', 'fcgi', 'uwsgi', 'scgi', 'logs', 'xdg-data', 'xdg-config']) mkdirSync(join(dir, d));
  const accessLog = join(dir, 'access.log');
  const snippets = join(ROOT, 'infrastructure/nginx/snippets');
  // Include paths are quoted because this repo's path contains a space.
  const conf = readFileSync(join(ROOT, 'infrastructure/nginx/default.conf'), 'utf8')
    .replace(/include \/etc\/nginx\/snippets\/(\S+);/g, `include "${snippets}/$1";`).replace('listen 80;', `listen ${opts.nginxPort};`).replace('server api:4000;', `server ${opts.apiAddr};`)
    .replace('access_log /dev/stdout pdftools_json;', `access_log ${accessLog} pdftools_json;`).replace('error_log /dev/stderr warn;', `error_log ${dir}/e.log warn;`)
    .replace('root /usr/share/nginx/html;', `root "${opts.webRoot ?? join(ROOT, 'apps/web/dist')}";`);
  const site = join(dir, 'site.conf'); writeFileSync(site, conf);
  const mime = [join(dirname(NGINX), '../conf/mime.types'), '/etc/nginx/mime.types'].find(existsSync)!;
  const main = join(dir, 'nginx.conf');
  writeFileSync(main, `worker_processes 1;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log info;\nevents { worker_connections 256; }\nhttp {\n  # Packaged nginx builds default to /var/log/nginx/access.log, which an unprivileged test run cannot open.\n  access_log ${dir}/default-access.log;\n  include ${mime};\n  default_type application/octet-stream;\n  client_body_temp_path ${dir}/body;\n  proxy_temp_path ${dir}/proxy;\n  fastcgi_temp_path ${dir}/fcgi;\n  uwsgi_temp_path ${dir}/uwsgi;\n  scgi_temp_path ${dir}/scgi;\n  include "${site}";\n}\n`);
  execFileSync(NGINX, ['-p', dir, '-c', main, '-t'], { stdio: 'pipe' });
  const ng = spawn(NGINX, ['-p', dir, '-c', main, '-g', 'daemon off;'], { stdio: 'ignore', detached: true });
  const cd = spawn(CADDY, ['run', '--config', join(ROOT, 'infrastructure/caddy/Caddyfile'), '--adapter', 'caddyfile'], {
    stdio: 'ignore', detached: true,
    env: { PATH: process.env.PATH!, HOME: dir, XDG_DATA_HOME: join(dir, 'xdg-data'), XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      SITE_ADDRESS: `localhost:${opts.caddyPort}`, HTTP_PORT: String(opts.caddyPort + 25), ACME_EMAIL: 'test@example.com', TLS_DIRECTIVE: 'tls internal', UPSTREAM: `127.0.0.1:${opts.nginxPort}` },
  });
  return { httpsUrl: `https://localhost:${opts.caddyPort}`, nginxUrl: `http://127.0.0.1:${opts.nginxPort}`, accessLog, stop: () => { for (const p of [cd, ng]) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } } } };
}
