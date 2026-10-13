#!/usr/bin/env node
// Execute a Dockerfile's filesystem steps WITHOUT Docker, in a clean directory, so the resulting tree can be started and tested.
//
//   node infrastructure/scripts/sim-docker-build.mjs <Dockerfile> --target <stage> --out <dir> [--build-arg K=V ...]
//
// What it runs: FROM/ARG/ENV/WORKDIR, COPY (honouring --from and .dockerignore), `RUN npm ...` and `RUN mkdir`.
// What it skips (needs a real image): apt-get, chown, USER, HEALTHCHECK, ENTRYPOINT... The point is to catch what a real
// build would fail on or miss: files not COPY'd, lockfile/workspace mismatches, devDependencies needed at runtime, wrong paths.
// It is a verification aid, not a replacement for `docker build` (CI still runs that).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';

const argv = process.argv.slice(2);
const dockerfile = argv[0];
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const target = opt('--target');
const out = resolve(opt('--out') ?? '');
const envOverrides = Object.fromEntries(argv.flatMap((a, i) => (a === '--env' ? [argv[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
const buildArgs = Object.fromEntries(argv.flatMap((a, i) => (a === '--build-arg' ? [argv[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
if (!dockerfile || !target || !opt('--out')) { console.error('usage: sim-docker-build.mjs <Dockerfile> --target <stage> --out <dir> [--build-arg K=V] [--env K=V]'); process.exit(2); }
const context = resolve('.');

// ---- .dockerignore (the subset we use: globs with ** and *, and ! negation)
const ignorePatterns = existsSync('.dockerignore') ? readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
const toRe = (p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '(?:/.*)?$');
const rules = ignorePatterns.map((p) => ({ neg: p.startsWith('!'), re: toRe(p.replace(/^!/, '')) }));
const ignored = (rel) => { let r = false; for (const x of rules) if (x.re.test(rel)) r = !x.neg; return r; };

// ---- parse
const text = readFileSync(dockerfile, 'utf8').replace(/\\\n/g, ' ');
const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const globalArgs = { ...buildArgs };
const stages = [];
for (const line of lines) {
  const [ins, ...rest] = line.split(/\s+/); const arg = rest.join(' ');
  const I = ins.toUpperCase();
  if (I === 'ARG' && !stages.length) { const [k, v] = arg.split(/=(.*)/s); if (!(k in globalArgs)) globalArgs[k] = v ?? ''; continue; }
  if (I === 'FROM') { const m = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(arg); stages.push({ base: m[1], name: m[2] ?? String(stages.length), steps: [] }); continue; }
  stages.at(-1)?.steps.push({ I, arg });
}
const subst = (s, env) => s.replace(/\$\{(\w+)(?::[-?][^}]*)?\}|\$(\w+)/g, (_, a, b) => env[a ?? b] ?? '');

const roots = {}; const envs = {}; const wds = {};
rmSync(out, { recursive: true, force: true });
const log = (...a) => console.log('[sim]', ...a);

function runStage(st) {
  const root = join(out, st.name, 'rootfs'); mkdirSync(root, { recursive: true });
  const base = stages.find((s) => s.name === subst(st.base, globalArgs));
  let env = { ...globalArgs }; let wd = '/';
  if (base) { cpSync(roots[base.name], root, { recursive: true, verbatimSymlinks: true }); env = { ...envs[base.name] }; wd = wds[base.name]; } // children inherit env and WORKDIR, as in Docker
  const host = (p) => join(root, p);
  for (const { I, arg } of st.steps) {
    if (I === 'ARG') { const [k, v] = arg.split(/=(.*)/s); env[k] = k in buildArgs ? buildArgs[k] : subst(v ?? globalArgs[k] ?? '', env); }
    else if (I === 'ENV') { for (const m of arg.matchAll(/(\w+)=("[^"]*"|\S*)/g)) env[m[1]] = m[1] in envOverrides ? envOverrides[m[1]] : subst(m[2].replace(/^"|"$/g, ''), env); } // --env K=V wins over ENV (e.g. use system Chrome instead of the image's bundled one)
    else if (I === 'WORKDIR') { wd = subst(arg, env).startsWith('/') ? subst(arg, env) : join(wd, subst(arg, env)); mkdirSync(host(wd), { recursive: true }); }
    else if (I === 'COPY') {
      const toks = subst(arg, env).split(/\s+/); let from = null;
      if (toks[0].startsWith('--from=')) from = toks.shift().slice(7);
      const dest = toks.pop(); const srcs = toks;
      const absDest = dest.startsWith('/') ? dest : join(wd, dest);
      const destIsDir = dest.endsWith('/') || srcs.length > 1 || dest === '.';
      for (const s of srcs) {
        const srcBase = from ? join(roots[from] ?? '', '') : context;
        const src = join(srcBase, s);
        if (!existsSync(src)) throw new Error(`COPY failed: "${s}" not found in ${from ? `stage ${from}` : 'build context'} (a real build would fail too)`);
        if (!from && ignored(relative(context, src))) throw new Error(`COPY failed: "${s}" is excluded by .dockerignore`);
        const dst = destIsDir ? join(host(absDest), statSync(src).isDirectory() ? '' : basename(src)) : host(absDest);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (p) => from || !ignored(relative(context, p)) });
      }
    }
    else if (I === 'RUN') {
      const cmds = subst(arg, env).split('&&').map((c) => c.trim());
      for (const c of cmds) {
        if (/^npm\s/.test(c)) { log(`${st.name}: ${c}`); execFileSync('sh', ['-c', c], { cwd: host(wd), env: { ...process.env, ...env, CI: 'true', npm_config_loglevel: 'error' }, stdio: ['ignore', 'inherit', 'inherit'] }); }
        else if (/^mkdir\s/.test(c)) { for (const p of c.replace(/^mkdir\s+(-p\s+)?/, '').split(/\s+/)) mkdirSync(host(p), { recursive: true }); }
        else log(`${st.name}: skipped (needs a real image): ${c.slice(0, 70)}`);
      }
    }
  }
  roots[st.name] = root; envs[st.name] = env; wds[st.name] = wd;
}

const wanted = new Set(); const need = (n) => { const st = stages.find((s) => s.name === n); if (!st || wanted.has(n)) return; wanted.add(n); const b = stages.find((s) => s.name === subst(st.base, globalArgs)); if (b) need(b.name); for (const s of st.steps) if (s.I === 'COPY' && s.arg.includes('--from=')) need(/--from=(\S+)/.exec(s.arg)[1]); };
need(target);
for (const st of stages) if (wanted.has(st.name)) { log(`stage ${st.name}`); runStage(st); }
console.log(JSON.stringify({ rootfs: roots[target], env: envs[target] }));
