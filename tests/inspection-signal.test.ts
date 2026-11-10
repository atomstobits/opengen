import { expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (_path: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
      callback(
        Object.assign(new Error('Synthetic termination.'), { code: null, signal: 'SIGKILL' }),
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'png', width: 16, height: 16 }],
        }),
        '',
      );
    },
  ),
}));
import { inspectOutput } from '../packages/engine/src/inspection';
it('does not treat signaled native output as a successful probe even if stdout is complete', async () => {
  const result = await inspectOutput(Buffer.from('synthetic bytes'), 'image/png', {
    probePath: '/fixture/ffprobe',
    decodePath: '/fixture/ffmpeg',
    networkIsolated: true,
  });
  expect(result.metadata).toEqual({ status: 'unknown', reason: 'inspector_resource_limit' });
  expect(result.decode).toMatchObject({ status: 'unknown', coverage: 'none' });
  expect(result.measured.width).toBeNull();
});
