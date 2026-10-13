export interface Limits {
  maxFileBytes: number;
  maxFiles: number;
  maxPages: number;
  maxConcurrentJobs: number;
  jobTimeoutMs: number;
  retentionMinutes: number;
}

/** Default guest limits; the API overrides these from environment/admin config. */
export const DEFAULT_GUEST_LIMITS: Limits = {
  maxFileBytes: 50 * 1024 * 1024,
  maxFiles: 20,
  maxPages: 500,
  maxConcurrentJobs: 2,
  jobTimeoutMs: 120_000,
  retentionMinutes: 60,
};
