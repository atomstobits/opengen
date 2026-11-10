import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const input = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'Synthetic sea.', duration: 5, resolution: '720p' },
  maxCostMicros: 1_000_000,
};

describe('persisted example receipt recovery', () => {
  it('uses lookup only for old and attempted receipts, even when --execute is repeated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengen-example-recovery-'));
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.writeHead(404).end(
        JSON.stringify({
          error: { code: 'submission_not_found', message: 'Acceptance remains unknown.' },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture server.');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      for (const submission of [undefined, 'attempted']) {
        const receiptPath = join(directory, `${submission ?? 'legacy'}.json`);
        const receipt = {
          version: 1,
          baseUrl,
          input,
          idempotencyKey: 'original-persisted-key',
          requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
          ...(submission ? { submission } : {}),
        };
        const original = JSON.stringify(receipt);
        await writeFile(receiptPath, original, { mode: 0o600 });
        try {
          await run(
            process.execPath,
            [
              join(root, 'node_modules/tsx/dist/cli.mjs'),
              join(root, 'examples/generate.ts'),
              '--receipt',
              receiptPath,
              '--execute',
            ],
            {
              cwd: root,
              timeout: 15000,
              env: {
                PATH: process.env.PATH,
                HOME: directory,
                MEDIA_ROUTER_URL: baseUrl,
                MEDIA_ROUTER_TOKEN: 'fixture-only',
                NODE_OPTIONS: '',
              },
            },
          );
          throw new Error('Expected unresolved acceptance.');
        } catch (error) {
          expect((error as { stderr: string }).stderr).toContain(
            'rerunning only looks up the original key',
          );
        }
        expect(await readFile(receiptPath, 'utf8')).toBe(original);
      }
      expect(seen).toEqual([
        'GET /v1/generations/lookup?idempotencyKey=original-persisted-key',
        'GET /v1/generations/lookup?idempotencyKey=original-persisted-key',
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
