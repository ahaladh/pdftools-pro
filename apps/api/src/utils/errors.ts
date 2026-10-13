export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
