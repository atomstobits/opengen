import { describe, expect, it, vi } from 'vitest';
import {
  ApiResponseError,
  apiErrorCode,
  apiErrorMessage,
  readApiJson,
} from '../apps/web/app/dashboard/api-response';

describe('dashboard API response parsing and error extraction', () => {
  it('extracts trimmed error messages and codes from structured JSON error envelopes', () => {
    expect(apiErrorMessage({ error: '  The gateway is not reachable.  ' })).toBe(
      'The gateway is not reachable.',
    );
    expect(
      apiErrorMessage({
        error: { code: 'insufficient_scope', message: '  Read access required. ' },
      }),
    ).toBe('Read access required.');
    expect(
      apiErrorCode({ error: { code: ' browser_authority_changed ', message: 'Changed.' } }),
    ).toBe('browser_authority_changed');

    for (const empty of [
      null,
      undefined,
      'string',
      42,
      [],
      {},
      { error: '' },
      { error: '   ' },
      { error: { code: '  ', message: '   ' } },
      { error: 123 },
    ]) {
      expect(apiErrorMessage(empty)).toBeUndefined();
      expect(apiErrorCode(empty)).toBeUndefined();
    }
  });

  it.each([
    [
      404,
      '<!DOCTYPE html><html><head><title>404</title></head><body>Not Found</body></html>',
      'text/html',
    ],
    [502, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'text/html; charset=utf-8'],
    [503, 'Service Temporarily Unavailable', 'text/plain'],
    [500, '', 'text/plain'],
  ])(
    'returns the clean fallback message on non-JSON HTTP %s responses instead of SyntaxError',
    async (status, body, contentType) => {
      const onError = vi.fn();
      const response = new Response(body, {
        status,
        headers: { 'content-type': contentType },
      });
      const fallback = 'Activity could not be loaded. Try refreshing.';
      let caught: unknown;
      try {
        await readApiJson(response, fallback, { onError });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiResponseError);
      const apiError = caught as ApiResponseError;
      expect(apiError.message).toBe(fallback);
      expect(apiError.message).not.toContain('Unexpected token');
      expect(apiError.message).not.toContain('<');
      expect(apiError.status).toBe(status);
      expect(apiError.code).toBeUndefined();
      expect(apiError.hasServerMessage).toBe(false);
      expect(onError).toHaveBeenCalledWith({ status, code: undefined, body: undefined });
    },
  );

  it('preserves structured JSON string and object error messages and invokes onError with code', async () => {
    const stringErr = new Response(JSON.stringify({ error: 'The gateway is not reachable.' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    await expect(readApiJson(stringErr, 'Fallback message.')).rejects.toMatchObject({
      name: 'ApiResponseError',
      message: 'The gateway is not reachable.',
      status: 503,
      code: undefined,
      hasServerMessage: true,
    });

    const onError = vi.fn();
    const conflictBody = {
      error: {
        code: 'browser_authority_changed',
        message: 'Your authorized workspace or identity changed.',
      },
    };
    const conflict = new Response(JSON.stringify(conflictBody), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
    await expect(readApiJson(conflict, 'Fallback message.', { onError })).rejects.toMatchObject({
      name: 'ApiResponseError',
      message: 'Your authorized workspace or identity changed.',
      status: 409,
      code: 'browser_authority_changed',
      hasServerMessage: true,
    });
    expect(onError).toHaveBeenCalledWith({
      status: 409,
      code: 'browser_authority_changed',
      body: conflictBody,
    });

    const emptyMessage = new Response(
      JSON.stringify({ error: { code: 'browser_authority_changed', message: '   ' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
    await expect(readApiJson(emptyMessage, 'Clean fallback.')).rejects.toMatchObject({
      name: 'ApiResponseError',
      message: 'Clean fallback.',
      status: 409,
      code: 'browser_authority_changed',
      hasServerMessage: false,
    });
  });

  it('rejects malformed, HTML, empty, null, or primitive 200 OK bodies with the clean fallback', async () => {
    const fallback = 'Usage report could not be loaded.';
    const onError = vi.fn();
    for (const raw of [
      '<!DOCTYPE html><html><body>Unexpected proxy login page</body></html>',
      '{ "broken": ',
      '',
      '   ',
      'null',
      '"plain-string"',
      '42',
      'true',
      JSON.stringify({ data: 'not-an-object' }),
    ]) {
      const response = new Response(raw, { status: 200 });
      await expect(readApiJson(response, fallback, { onError })).rejects.toMatchObject({
        name: 'ApiResponseError',
        message: fallback,
        status: 200,
        hasServerMessage: false,
      });
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it('unwraps { data } envelopes and returns plain JSON objects directly on 200 OK', async () => {
    expect(
      await readApiJson<{ id: string }[]>(Response.json({ data: [{ id: 'key-1' }] }), 'Fallback.'),
    ).toEqual([{ id: 'key-1' }]);
    expect(await readApiJson<unknown[]>(Response.json({ data: [] }), 'Fallback.')).toEqual([]);
    expect(
      await readApiJson<{ items: unknown[]; nextCursor: string | null }>(
        Response.json({ items: [], nextCursor: null }),
        'Fallback.',
      ),
    ).toEqual({ items: [], nextCursor: null });
    expect(
      await readApiJson<{ availableMicros: number }>(
        Response.json({ availableMicros: 500_000 }),
        'Fallback.',
      ),
    ).toEqual({ availableMicros: 500_000 });
  });

  it('rethrows AbortError without calling onError when aborted before or during body read', async () => {
    const onError = vi.fn();
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(
      readApiJson(new Response('<html>503</html>', { status: 503 }), 'Fallback.', {
        signal: controller.signal,
        onError,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(onError).not.toHaveBeenCalled();

    const abortingResponse = {
      ok: false,
      status: 503,
      text: async () => {
        throw new DOMException('Aborted', 'AbortError');
      },
    } as unknown as Response;
    await expect(readApiJson(abortingResponse, 'Fallback.', { onError })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
