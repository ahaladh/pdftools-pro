export const JOB_STATES = ['queued', 'uploading', 'processing', 'completed', 'failed', 'cancelled', 'expired'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobResultFile {
  fileId: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface JobView {
  id: string;
  tool: string;
  state: JobState;
  progress: number;
  createdAt: string;
  expiresAt: string;
  error?: { code: string; message: string };
  warnings: string[];
  /** Tool-specific result facts, e.g. compression sizes. */
  stats?: Record<string, number | string>;
  result?: JobResultFile & { downloadUrl: string };
}

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: { code: string; message: string; details?: unknown } };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export interface PublicConfig {
  brand: string;
  limits: { maxFileMB: number; maxFiles: number; maxPages: number; retentionMinutes: number };
  maintenance: boolean;
  features: { accounts: boolean; billing: boolean; /** Administrators must use a second sign-in step. */ adminTwoFactor: boolean; /** How teams pay: one flat price, or per seat. */ teamBilling: 'flat' | 'per_seat' };
}
