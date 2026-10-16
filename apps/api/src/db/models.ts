import mongoose, { Schema, type Model } from 'mongoose';

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  plan: { type: String, enum: ['free', 'pro', 'business'], default: 'free' },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  failedLogins: { type: Number, default: 0 },
  lockedUntil: { type: Date },
  lastLoginAt: { type: Date },
  resetTokenHash: { type: String },
  resetTokenExpires: { type: Date },
  /** Set when the user clicks the link we emailed (or completes a password reset, which proves the same thing). */
  emailVerifiedAt: { type: Date },
  verifyTokenHash: { type: String },
  verifyTokenExpires: { type: Date },
  verifySentAt: { type: Date },
  /** Two-factor sign-in (TOTP). The secret is AES-GCM encrypted; recovery codes are stored only as hashes. */
  twoFactor: {
    secretEnc: String,
    enabledAt: Date,
    /** Last accepted TOTP time step: a code cannot be used twice. */
    lastStep: Number,
    recoveryHashes: [String],
    failed: { type: Number, default: 0 },
  },
  twoFactorPending: { secretEnc: String, createdAt: Date },
  billing: {
    customerId: String,
    subscriptionId: String,
    status: String,
    plan: String,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: Boolean,
  },
}, { timestamps: true });

/** Refresh-token sessions. Only a SHA-256 of the token is stored. `family` enables reuse detection. */
const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  family: { type: String, required: true, index: true },
  /** When this sign-in (family) began; preserved across refresh-token rotations. */
  since: { type: Date },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: { type: Date },
  userAgent: { type: String, maxlength: 300 },
}, { timestamps: true });

const jobSchema = new Schema({
  id: { type: String, required: true, unique: true },
  owner: { type: String, required: true, index: true },
  tool: String,
  state: { type: String, index: true },
  progress: Number,
  options: Schema.Types.Mixed,
  inputs: [{ _id: false, path: String, name: String, kind: String }],
  dir: String,
  createdAt: { type: Number, index: true },
  expiresAt: { type: Number, index: true },
  error: { _id: false, code: String, message: String },
  warnings: [String],
  stats: Schema.Types.Mixed,
  result: Schema.Types.Mixed,
  plan: String,
  priority: Number,
  limits: Schema.Types.Mixed,
  usageKeys: [String],
  heartbeatAt: Number,
  cancelRequested: Boolean,
  /** Metadata outlives files by 30 days for history, then Mongo removes it. */
  purgeAt: { type: Date, index: { expires: 0 } },
}, { minimize: false });

const usageSchema = new Schema({
  key: { type: String, required: true },
  day: { type: String, required: true },
  ops: { type: Number, default: 0 },
  byTool: { type: Map, of: Number, default: {} },
}, { versionKey: false });
usageSchema.index({ key: 1, day: 1 }, { unique: true });
usageSchema.index({ day: 1 });

const settingSchema = new Schema({ _id: String, value: Schema.Types.Mixed }, { versionKey: false });

const auditSchema = new Schema({
  at: { type: Date, default: Date.now, index: true },
  actor: { type: String, index: true },
  action: { type: String, index: true },
  target: String,
  ip: String,
  meta: Schema.Types.Mixed,
}, { versionKey: false });

const billingEventSchema = new Schema({ _id: String, type: String, at: { type: Date, default: Date.now, index: { expires: 60 * 60 * 24 * 90 } } }, { versionKey: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const model = (name: string, schema: Schema): Model<any> => (mongoose.models[name] as Model<any> | undefined) ?? mongoose.model(name, schema);
export const UserModel = model('User', userSchema);
export const SessionModel = model('Session', sessionSchema);
export const JobModel = model('Job', jobSchema);
export const UsageModel = model('Usage', usageSchema);
export const SettingModel = model('Setting', settingSchema);
export const AuditModel = model('Audit', auditSchema);
export const BillingEventModel = model('BillingEvent', billingEventSchema);

export async function connectDb(uri: string) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([UserModel, SessionModel, JobModel, UsageModel, AuditModel].map((x) => x.init()));
}
export const disconnectDb = () => mongoose.disconnect();
