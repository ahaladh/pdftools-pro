import { UserModel } from '../db/models.js';
import { openSecret, sealSecret, tryOpenSecret } from '../modules/auth/totp.js';

/** The two places an authenticator secret is stored: active, and set up but not yet confirmed. */
const FIELDS = ['twoFactor.secretEnc', 'twoFactorPending.secretEnc'] as const;
type Field = (typeof FIELDS)[number];

export interface KeyReport {
  /** Secrets examined. */
  secrets: number;
  /** Count per key: `current`, `previous#1`…; never any key material. */
  byKey: Record<string, number>;
  /** Count per stored format. `v1` carries no key id and is upgraded to `v2` when rotated. */
  byFormat: { v1: number; v2: number };
  /** Already sealed with the current key in the current format: nothing to do. */
  onCurrent: number;
  /** Would be (dry run) or were re-sealed. */
  needsRotation: number;
  /** None of the configured keys opens these. Left untouched. Ids only, never emails or secrets. */
  undecryptable: { userId: string; field: Field }[];
}
export interface RotationResult extends KeyReport {
  rotated: number;
  /** Someone changed the value between reading and writing (for example a user re-did their setup): left alone, run again. */
  raced: number;
  dryRun: boolean;
}

const label = (i: number) => (i === 0 ? 'current' : `previous#${i}`);

async function* secrets(batch: number) {
  const filter = { $or: FIELDS.map((f) => ({ [f]: { $exists: true, $type: 'string' } })) };
  let after: unknown;
  for (;;) {
    const rows = await UserModel.find(after ? { ...filter, _id: { $gt: after } } : filter).sort({ _id: 1 }).limit(batch)
      .select('twoFactor.secretEnc twoFactorPending.secretEnc').lean<{ _id: unknown; twoFactor?: { secretEnc?: string }; twoFactorPending?: { secretEnc?: string } }[]>();
    if (!rows.length) return;
    for (const r of rows) {
      if (typeof r.twoFactor?.secretEnc === 'string') yield { id: r._id, field: FIELDS[0], sealed: r.twoFactor.secretEnc };
      if (typeof r.twoFactorPending?.secretEnc === 'string') yield { id: r._id, field: FIELDS[1], sealed: r.twoFactorPending.secretEnc };
    }
    after = rows[rows.length - 1]!._id;
  }
}

/**
 * Walk every stored authenticator secret and, unless `dryRun`, re-seal those not already on the current key in the current
 * format. Safe on a live system and safe to repeat or interrupt: each write is compare-and-set on the exact old ciphertext,
 * the plaintext is unchanged (so codes keep working and replay protection is untouched), the new value is opened again before
 * it is written, and anything that cannot be opened is reported and left exactly as it was. `keys[0]` is the current key.
 */
export async function rotateTwoFactorKeys(keys: readonly string[], opts: { dryRun?: boolean; batchSize?: number } = {}): Promise<RotationResult> {
  const dryRun = !!opts.dryRun;
  const out: RotationResult = { secrets: 0, byKey: {}, byFormat: { v1: 0, v2: 0 }, onCurrent: 0, needsRotation: 0, undecryptable: [], rotated: 0, raced: 0, dryRun };
  for await (const s of secrets(opts.batchSize ?? 200)) {
    out.secrets++;
    let opened: ReturnType<typeof tryOpenSecret>;
    try { opened = tryOpenSecret(keys, s.sealed); } catch { opened = null; }
    if (!opened) { out.undecryptable.push({ userId: String(s.id), field: s.field }); out.byKey.unknown = (out.byKey.unknown ?? 0) + 1; continue; }
    out.byKey[label(opened.keyIndex)] = (out.byKey[label(opened.keyIndex)] ?? 0) + 1;
    out.byFormat[opened.format]++;
    try {
      if (opened.keyIndex === 0 && opened.format === 'v2') { out.onCurrent++; continue; }
      out.needsRotation++;
      if (dryRun) continue;
      const fresh = sealSecret(keys[0]!, opened.plain);
      if (!openSecret(keys[0]!, fresh).equals(opened.plain)) throw new Error('re-sealed value does not decrypt to the original: refusing to write');
      const r = await UserModel.updateOne({ _id: s.id, [s.field]: s.sealed }, { $set: { [s.field]: fresh } });
      if (r.modifiedCount === 1) out.rotated++; else out.raced++;
    } finally { opened.plain.fill(0); }
  }
  return out;
}

/** Read-only: the same walk without writing. */
export async function inspectTwoFactorKeys(keys: readonly string[]): Promise<KeyReport> {
  const { rotated: _r, raced: _a, dryRun: _d, ...report } = await rotateTwoFactorKeys(keys, { dryRun: true });
  return report;
}
