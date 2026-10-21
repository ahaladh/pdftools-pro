import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { AuditModel, InviteModel, JobModel, MemberModel, SessionModel, TeamModel, UsageModel, UserModel } from './models.js';

/**
 * Forward-only, ordered, idempotent data migrations, recorded in the `migrations` collection.
 * Rules: never edit a shipped migration (add a new one); each must be safe to re-run; destructive
 * changes need an explicit, reviewed migration. Index creation uses createIndexes (additive), never
 * syncIndexes (which would drop indexes it doesn't know about).
 */
export interface Migration { id: string; description: string; up: () => Promise<void> }

export const MIGRATIONS: Migration[] = [
  {
    id: '0001-indexes',
    description: 'Create all collection indexes (unique emails, session/job lookups, TTL purges)',
    up: async () => { for (const m of [UserModel, SessionModel, JobModel, UsageModel, AuditModel]) await m.createIndexes(); },
  },
  {
    id: '0002-normalize-emails',
    description: 'Trim and lowercase stored emails (aborts, changing nothing, if that would create duplicates)',
    up: async () => {
      const users = mongoose.connection.collection('users');
      const dupes = await users.aggregate([
        { $group: { _id: { $toLower: { $trim: { input: '$email' } } }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 5 },
      ]).toArray();
      if (dupes.length) throw new Error(`cannot normalize emails: ${dupes.length}+ addresses differ only by case/whitespace; resolve them manually first`);
      await users.updateMany({}, [{ $set: { email: { $toLower: { $trim: { input: '$email' } } } } }]);
    },
  },
  {
    id: '0003-scrub-job-secrets',
    description: 'Remove any password fields that may linger in historical job records',
    up: async () => { await mongoose.connection.collection('jobs').updateMany({}, { $unset: { 'options.password': '', 'options.ownerPassword': '' } }); },
  },
  {
    id: '0004-team-indexes',
    description: 'Create the team collections\' indexes (one team per person, unique invitations)',
    up: async () => { for (const m of [TeamModel, MemberModel, InviteModel]) await m.createIndexes(); },
  },
  {
    id: '0005-security-key-index',
    description: 'Create the unique index on security-key credential ids',
    up: async () => { await UserModel.createIndexes(); },
  },
];

export class SchemaTooNewError extends Error {
  constructor(public unknown: string[]) { super(`The database has migrations this version does not know (${unknown.join(', ')}). You are probably running older code against a newer database; deploy the newer version, or restore a backup taken before the upgrade.`); }
}

const col = () => mongoose.connection.collection<{ _id: string; appliedAt?: Date; durationMs?: number; expiresAt?: Date }>('migrations');
const LOCK = '__lock__';

export async function migrationStatus(list = MIGRATIONS) {
  const rows = await col().find({ _id: { $ne: LOCK } }).toArray();
  const applied = new Set(rows.map((r) => r._id));
  return {
    applied: list.filter((m) => applied.has(m.id)).map((m) => m.id),
    pending: list.filter((m) => !applied.has(m.id)).map((m) => m.id),
    unknown: [...applied].filter((id) => !list.some((m) => m.id === id)),
  };
}

/** Throw if the database is ahead of this code (rollback safety). */
export async function assertSchemaNotNewer(list = MIGRATIONS) {
  const s = await migrationStatus(list);
  if (s.unknown.length) throw new SchemaTooNewError(s.unknown);
}

/** Apply pending migrations under a cross-process lock so replicas starting together run each exactly once. */
export async function runMigrations(log: Logger, list = MIGRATIONS, opts: { lockMs?: number; waitMs?: number } = {}): Promise<string[]> {
  await assertSchemaNotNewer(list);
  const lockMs = opts.lockMs ?? 10 * 60_000;
  const deadline = Date.now() + (opts.waitMs ?? lockMs);
  for (;;) {
    const now = new Date();
    try {
      await col().updateOne({ _id: LOCK, $or: [{ expiresAt: { $lt: now } }, { expiresAt: { $exists: false } }] } as never, { $set: { expiresAt: new Date(now.getTime() + lockMs) } }, { upsert: true });
      break; // acquired (upsert conflicts with an existing live lock via the _id unique index)
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      if (Date.now() > deadline) throw new Error('timed out waiting for another process to finish migrating');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const done: string[] = [];
  try {
    const { pending } = await migrationStatus(list);
    for (const id of pending) {
      const m = list.find((x) => x.id === id)!;
      const t0 = Date.now();
      log.info({ migration: id, description: m.description }, 'applying migration');
      await m.up(); // a throw here leaves it unrecorded, so it is retried (and fixed) on the next run
      await col().insertOne({ _id: id, appliedAt: new Date(), durationMs: Date.now() - t0 });
      done.push(id);
    }
  } finally { await col().deleteOne({ _id: LOCK }); }
  return done;
}
