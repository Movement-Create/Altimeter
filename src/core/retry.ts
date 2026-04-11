/**
 * Retry wrapper with exponential backoff for LLM API calls.
 *
 * Retries on:
 * - HTTP 429 (rate limit)
 * - HTTP 500, 502, 503, 529 (server errors)
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 *
 * Does NOT retry on:
 * - 400 (bad request — our fault)
 * - 401/403 (auth — won't change on retry)
 * - 404 (model not found)
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Called before each retry. Return false to abort. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => boolean | void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND",
  "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT",
]);

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Check for HTTP status codes in error message
    for (const code of RETRYABLE_STATUS_CODES) {
      if (message.includes(String(code)) || message.includes(`status ${code}`)) {
        return true;
      }
    }

    // Check for network error codes
    const anyError = error as unknown as Record<string, unknown>;
    if (typeof anyError.code === "string" && RETRYABLE_ERROR_CODES.has(anyError.code)) {
      return true;
    }

    // Check for "overloaded" or "rate limit" in message
    if (message.includes("overloaded") || message.includes("rate limit") || message.includes("too many requests")) {
      return true;
    }
  }

  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxRetries || !isRetryable(error)) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
        opts.maxDelayMs
      );

      if (opts.onRetry) {
        const shouldContinue = opts.onRetry(attempt + 1, error, delay);
        if (shouldContinue === false) throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
