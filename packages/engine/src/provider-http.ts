import { SubmissionRejected, SubmissionUnknown } from './adapters.js';

export type ProviderJson = Record<string, unknown>;
export const providerObject = (value: unknown): ProviderJson =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ProviderJson)
    : {};

/** Bounded decoding, with no upstream body/error text crossing the public boundary. */
export async function providerJson(
  response: Response,
  maxBytes = 2_000_000,
): Promise<ProviderJson> {
  if (!response.body) throw new Error('Provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('Provider response exceeded the supported limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return providerObject(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function submitProviderJson(
  request: typeof fetch,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ProviderJson> {
  let response: Response;
  try {
    response = await request(url, {
      method: 'POST',
      redirect: 'error',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch {
    throw new SubmissionUnknown();
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    await response.body?.cancel();
    throw new SubmissionRejected(`${provider} rejected submission (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SubmissionUnknown(`${provider} submission acceptance could not be confirmed.`);
  }
  try {
    return await providerJson(response, options.maxBytes);
  } catch {
    throw new SubmissionUnknown(`${provider} returned an unreadable submission response.`);
  }
}

export async function pollProviderJson(
  request: typeof fetch,
  provider: string,
  url: string,
  headers: Record<string, string>,
  maxBytes?: number,
): Promise<ProviderJson> {
  const response = await request(url, {
    redirect: 'error',
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${provider} status request failed (HTTP ${response.status}).`);
  }
  return providerJson(response, maxBytes);
}
