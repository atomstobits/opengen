import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  reserved.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2002::', 16],
] as const)
  reserved.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !reserved.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
}

export class PublicTargetRejectedError extends Error {
  readonly statusCode = 400;
  readonly code = 'public_target_rejected';

  constructor(message: string) {
    super(message);
    this.name = 'PublicTargetRejectedError';
  }
}

export type PublicResolver = (hostname: string) => Promise<LookupAddress[]>;
const resolveAll: PublicResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export interface ResolvePublicTargetOptions {
  label?: string;
  allowIpLiteral?: boolean;
}

export async function resolvePublicTarget(
  value: string,
  resolver: PublicResolver = resolveAll,
  options: ResolvePublicTargetOptions = {},
) {
  const label = options.label ?? 'Webhook';
  const allowIpLiteral = options.allowIpLiteral ?? true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicTargetRejectedError(`A valid ${label.toLowerCase()} URL is required.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new PublicTargetRejectedError(
      `${label} destinations require public HTTPS on port 443 without user information or fragments.`,
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal)$/i.test(hostname))
    throw new PublicTargetRejectedError(`A public ${label.toLowerCase()} destination is required.`);
  const directFamily = isIP(hostname);
  if (directFamily && !allowIpLiteral)
    throw new PublicTargetRejectedError(
      `${label} destinations must use a public DNS hostname, not an IP literal.`,
    );
  let addresses: LookupAddress[];
  try {
    addresses = directFamily
      ? [{ address: hostname, family: directFamily }]
      : await Promise.race([
          resolver(hostname),
          new Promise<never>((_resolve, reject) =>
            AbortSignal.timeout(5000).addEventListener(
              'abort',
              () => reject(new Error(`${label} DNS lookup timed out.`)),
              { once: true },
            ),
          ),
        ]);
  } catch (error) {
    if (label === 'Webhook' && error instanceof Error && error.message.includes('timed out')) {
      throw error;
    }
    throw new PublicTargetRejectedError(
      `${label} destination could not be resolved to a public address.`,
    );
  }
  // Reject mixed public/private answers, not just the first result. Every delivery resolves again.
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new PublicTargetRejectedError(
      `The ${label.toLowerCase()} destination does not resolve exclusively to public addresses.`,
    );
  return { url, address: addresses[0]! };
}

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function normalizeRequestBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new PublicTargetRejectedError('Unsupported request body for pinned public HTTPS request.');
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else {
      result.set(key, value);
    }
  }
  return result;
}

export interface PublicPinnedFetchOptions {
  resolve?: PublicResolver;
  httpsRequest?: typeof request;
  maxBytes?: number;
}

/**
 * Resolves DNS once per request, rejects any private/loopback/link-local/reserved or mixed
 * response, pins the TLS socket directly to the verified public IP while preserving hostname
 * verification (SNI), and refuses redirects.
 */
export function createPublicPinnedFetch(options: PublicPinnedFetchOptions = {}): typeof fetch {
  const httpsRequest = options.httpsRequest ?? request;
  const maxBytes = options.maxBytes ?? 2_000_000;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlString =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const redirectMode = init?.redirect ?? (input instanceof Request ? input.redirect : 'error');
    if (redirectMode !== 'error') {
      throw new PublicTargetRejectedError('Provider endpoint redirects are not allowed.');
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const target = await (signal
      ? Promise.race([
          resolvePublicTarget(urlString, options.resolve, {
            label: 'Provider endpoint',
            allowIpLiteral: false,
          }),
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(signal.reason ?? new Error('Provider endpoint request timed out.')),
              { once: true },
            ),
          ),
        ])
      : resolvePublicTarget(urlString, options.resolve, {
          label: 'Provider endpoint',
          allowIpLiteral: false,
        }));
    signal?.throwIfAborted();
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const headers = normalizeRequestHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const bodyBuffer = normalizeRequestBody(init?.body);
    if (bodyBuffer !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(bodyBuffer.byteLength);
    }
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(
        target.url,
        {
          method,
          agent: false,
          signal: signal ?? undefined,
          family: target.address.family,
          servername: target.url.hostname,
          lookup: (
            _hostname: string,
            lookupOptions: number | LookupOneOptions | LookupAllOptions,
            callback: (
              err: NodeJS.ErrnoException | null,
              address: string | LookupAddress[],
              family?: number,
            ) => void,
          ) => {
            if (typeof lookupOptions === 'object' && lookupOptions !== null && lookupOptions.all) {
              callback(null, [{ address: target.address.address, family: target.address.family }]);
              return;
            }
            callback(null, target.address.address, target.address.family);
          },
          headers,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new Error('Provider endpoint redirects are not allowed.'));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
              response.destroy(new Error('Provider response exceeded the supported limit.'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              if (status < 200 || status > 599) {
                reject(new Error(`Provider returned unsupported HTTP status (${status}).`));
                return;
              }
              const responseBody =
                status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
              resolve(
                new Response(responseBody, {
                  status,
                  headers: toWebHeaders(response.headers),
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.once('error', reject);
      if (bodyBuffer !== undefined) {
        outgoing.end(bodyBuffer);
      } else {
        outgoing.end();
      }
    });
  };
}

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}
export type WebhookSender = (input: WebhookRequest) => Promise<{ statusCode: number }>;

export const sendPublicWebhook: WebhookSender = async ({ url, body, headers }) => {
  const signal = AbortSignal.timeout(10_000);
  const target = await Promise.race([
    resolvePublicTarget(url),
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Webhook delivery timed out.')), {
        once: true,
      }),
    ),
  ]);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const outgoing = request(
      target.url,
      {
        method: 'POST',
        agent: false,
        signal,
        family: target.address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, target.address.address, target.address.family),
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': 'OpenGen-Webhooks/0.1',
        },
      },
      (response) => {
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 8192) response.destroy(new Error('Webhook response exceeded limit.'));
        });
        response.once('error', reject);
        response.once('end', () => resolve({ statusCode: response.statusCode ?? 0 }));
        // Deliberately do not follow redirects or retain response bodies.
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
};
