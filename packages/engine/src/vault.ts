import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey(key?: string): Buffer {
  if (!key || !/^[a-f0-9]{64}$/i.test(key))
    throw Object.assign(new Error('Configure a 32-byte hex MR_VAULT_KEY for encrypted secrets.'), {
      statusCode: 503,
      code: 'vault_not_configured',
    });
  return Buffer.from(key, 'hex');
}

export function sealVault(value: unknown, key: string | undefined, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openVault<T>(value: string, key: string | undefined, context: string): T {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 29) throw new Error('Encrypted secret is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
  );
}
