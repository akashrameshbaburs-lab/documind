/** Minimal typed HTTP error used across services and routes. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code ?? message.toLowerCase().replace(/\s+/g, "_");
    this.details = details;
  }
}
