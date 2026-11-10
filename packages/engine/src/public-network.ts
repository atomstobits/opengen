import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';

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

export type PublicResolver = (hostname: string) => Promise<LookupAddress[]>;
const resolveAll: PublicResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function resolvePublicTarget(value: string, resolver: PublicResolver = resolveAll) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw Object.assign(
      new Error(
        'Webhook destinations require public HTTPS on port 443 without user information or fragments.',
      ),
      { statusCode: 400 },
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal)$/i.test(hostname))
    throw Object.assign(new Error('A public webhook destination is required.'), {
      statusCode: 400,
    });
  const directFamily = isIP(hostname);
  const addresses = directFamily
    ? [{ address: hostname, family: directFamily }]
    : await Promise.race([
        resolver(hostname),
        new Promise<never>((_resolve, reject) =>
          AbortSignal.timeout(5000).addEventListener(
            'abort',
            () => reject(new Error('Webhook DNS lookup timed out.')),
            { once: true },
          ),
        ),
      ]);
  // Reject mixed public/private answers, not just the first result. Every delivery resolves again.
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw Object.assign(
      new Error('The webhook destination does not resolve exclusively to public addresses.'),
      { statusCode: 400 },
    );
  return { url, address: addresses[0]! };
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
