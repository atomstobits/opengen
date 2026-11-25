export class ApiResponseError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly hasServerMessage: boolean;

  constructor(
    message: string,
    status: number,
    options?: { code?: string; hasServerMessage?: boolean },
  ) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
    this.code = options?.code;
    this.hasServerMessage = options?.hasServerMessage ?? false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof Error && cause.name === 'AbortError')
  );
}

export function apiErrorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) {
    return error.code.trim();
  }
  return undefined;
}

export function apiErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = body.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return undefined;
}

export interface ReadApiJsonOptions {
  signal?: AbortSignal;
  onError?: (info: { status: number; code?: string; body: unknown }) => void;
}

async function readJsonBody(
  response: Response,
  signal?: AbortSignal,
): Promise<{ parsed: true; value: unknown } | { parsed: false }> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    signal?.throwIfAborted();
    if (isAbortError(cause)) throw cause;
    return { parsed: false };
  }
  signal?.throwIfAborted();
  if (!text.trim()) return { parsed: false };
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false };
  }
}

/**
 * Safely parses a JSON API response and unwraps `{ data }` envelopes on success.
 * Non-JSON bodies (such as HTML 404/502/503 error pages) and malformed JSON on
 * OK responses throw an `ApiResponseError` with `fallback` instead of a raw `SyntaxError`.
 */
export async function readApiJson<T>(
  response: Response,
  fallback: string,
  options: ReadApiJsonOptions = {},
): Promise<T> {
  const { signal, onError } = options;
  const body = await readJsonBody(response, signal);
  if (!response.ok) {
    const value = body.parsed ? body.value : undefined;
    const code = apiErrorCode(value);
    const serverMessage = apiErrorMessage(value);
    onError?.({ status: response.status, code, body: value });
    throw new ApiResponseError(serverMessage ?? fallback, response.status, {
      code,
      hasServerMessage: serverMessage !== undefined,
    });
  }
  if (!body.parsed) {
    throw new ApiResponseError(fallback, response.status);
  }
  const payload = isRecord(body.value) ? (body.value.data ?? body.value) : body.value;
  if (payload === null || typeof payload !== 'object') {
    throw new ApiResponseError(fallback, response.status);
  }
  return payload as T;
}
