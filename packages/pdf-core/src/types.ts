export interface InputFile {
  /** Absolute path in the job's private work directory. */
  path: string;
  /** Sanitized original filename (display only). */
  name: string;
  kind: 'pdf' | 'jpg' | 'png' | 'office';
}

import type { EngineLimits } from './exec.js';

export interface ProcessContext {
  /** Absolute epoch-ms deadline for the whole job (set by processTool from timeoutMs). Engines get the remaining time. */
  deadline?: number;
  /** Kernel limits applied to every external engine this job starts. */
  limits?: EngineLimits & { officeMemoryMB?: number };
  workDir: string;
  inputs: InputFile[];
  options: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  maxPages: number;
  onProgress?: (percent: number) => void;
  /** Apply the tool to each input in turn and return one ZIP (see batch.ts). Only for tools marked batchable. */
  batch?: boolean;
  /** Batch only: time each file may take (the whole batch has `timeoutMs`). */
  fileTimeoutMs?: number;
}

export interface ProcessResult {
  path: string;
  name: string;
  mime: string;
  warnings: string[];
  stats?: Record<string, number | string>;
}
