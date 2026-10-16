import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { ToolError } from './errors.js';
import { loadPdfFile } from './pdf.js';
import { runEngine, runEngineOut, baseName, one, parseOptions, PDF_MIME, type Processor } from './helpers.js';

const ICC_CANDIDATES = [
  '/usr/share/color/icc/ghostscript/srgb.icc', '/usr/share/color/icc/ghostscript/default_rgb.icc',
  '/usr/share/ghostscript/iccprofiles/srgb.icc', '/usr/share/ghostscript/iccprofiles/default_rgb.icc',
];
const exists = (p: string, mode = constants.R_OK) => access(p, mode).then(() => true, () => false);

async function findProfile(): Promise<string> {
  for (const p of [process.env.GS_ICC_PROFILE, ...ICC_CANDIDATES]) if (p && await exists(p)) return p;
  throw new ToolError('tool_unavailable', 'PDF/A conversion needs an sRGB ICC colour profile on the server (set GS_ICC_PROFILE).');
}

export interface Verdict { compliant: boolean; failures: { clause: string; description: string }[] }
/** Read veraPDF's machine-readable report. Unknown/odd output counts as NOT compliant. */
export function parseVeraReport(xml: string): Verdict {
  const m = /<validationReport[^>]*\sisCompliant="(true|false)"/.exec(xml);
  const failures = [...xml.matchAll(/<rule\b[^>]*\sclause="([^"]*)"[^>]*\sstatus="failed"[^>]*>\s*<description>([^<]*)<\/description>/g)].map((r) => ({ clause: r[1]!, description: r[2]!.trim() }));
  return { compliant: m?.[1] === 'true' && failures.length === 0, failures };
}

// JVMs reserve far more address space than they use, which the kernel memory limit would refuse; cap them explicitly.
const JVM_OPTS = '-Xmx512m -Xss1m -XX:ReservedCodeCacheSize=64m -XX:CompressedClassSpaceSize=64m -XX:MaxMetaspaceSize=192m -XX:+UseSerialGC';

const pdfToPdfa: Processor = async (ctx) => {
  const o = parseOptions('pdf-to-pdfa', ctx.options);
  const f = one(ctx);
  await loadPdfFile(f.path, ctx.maxPages); // rejects damaged and encrypted files with a clear message
  const icc = await findProfile();
  if (/[()\\\r\n]/.test(icc)) throw new ToolError('tool_unavailable', 'The ICC profile path contains unsupported characters.');
  const def = join(ctx.workDir, 'pdfa-def.ps');
  await writeFile(def, [
    '%!',
    '[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark',
    '[{icc_PDFA} <</N 3>> /PUT pdfmark',
    `[{icc_PDFA} (${icc}) (r) file /PUT pdfmark`,
    '[/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark',
    '[{OutputIntent_PDFA} <</Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile {icc_PDFA} /OutputConditionIdentifier (sRGB) /Info (sRGB)>> /PUT pdfmark',
    '[{Catalog} <</OutputIntents [ {OutputIntent_PDFA} ]>> /PUT pdfmark', '',
  ].join('\n'));
  const out = join(ctx.workDir, 'result.pdf');
  await runEngine(ctx, 'gs', [
    '-q', `-dPDFA=${o.level[0]}`, '-dBATCH', '-dNOPAUSE', '-dNOOUTERSAVE', '-dPDFACompatibilityPolicy=1',
    `--permit-file-read=${icc}`, '-sColorConversionStrategy=RGB', '-sProcessColorModel=DeviceRGB',
    '-dEmbedAllFonts=true', '-dSubsetFonts=true', '-sDEVICE=pdfwrite', `-sOutputFile=${out}`, def, f.path,
  ]);
  try { if ((await readFile(out)).length === 0) throw new Error('empty'); } catch { throw new ToolError('engine_failed', 'The PDF could not be converted to PDF/A.'); }

  const vera = process.env.VERAPDF_BIN;
  const warnings = [
    'PDF/A forbids encryption, JavaScript, audio/video and external content, so those were removed. Document metadata and interactive form fields may not carry over unchanged.',
  ];
  let validated: string;
  if (vera && await exists(vera, constants.X_OK)) {
    // veraPDF exits non-zero for a non-compliant file but still prints the report, so read stdout either way.
    const report = await runEngineOut(ctx, vera, ['--flavour', o.level, '--maxfailures', '5', out], { office: true, env: { JAVA_TOOL_OPTIONS: JVM_OPTS } })
      .catch((e: unknown) => {
        const stdout = (e as { stdout?: string }).stdout;
        if (e instanceof ToolError && e.code === 'engine_failed' && stdout?.includes('<validationReport')) return stdout;
        if (e instanceof ToolError && e.code === 'engine_failed') throw new ToolError('validator_failed', 'The PDF/A validator could not check the converted file, so it was not delivered.');
        throw e;
      });
    const v = parseVeraReport(report);
    if (!v.compliant) {
      const first = v.failures[0];
      throw new ToolError('pdfa_failed', `This document could not be made valid PDF/A-${o.level}${first ? ` (rule ${first.clause}: ${first.description.slice(0, 160)})` : ''}. It may contain content PDF/A does not allow, such as unembeddable fonts.`);
    }
    validated = 'veraPDF';
    warnings.unshift(`Checked with veraPDF: the result conforms to PDF/A-${o.level}.`);
  } else {
    validated = 'no';
    warnings.unshift(`Converted with PDF/A-${o.level} settings, but NOT independently validated (the veraPDF checker is not installed on this server). Do not rely on it for compliance without checking it yourself.`);
  }
  return { path: out, name: `${baseName(f.name)}-pdfa.pdf`, mime: PDF_MIME, warnings, stats: { level: o.level, validated } };
};

export const PDFA_TOOLS = { 'pdf-to-pdfa': pdfToPdfa };
