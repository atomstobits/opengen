import { expect, it } from 'vitest';
import { operationalError } from '../apps/server/src/operational-error';
it('keeps private error messages, SQL details and provider receipts out of operational logs', () => {
  const privateValue = 'SYNTHETIC_PRIVATE_PROMPT_AND_CAPABILITY';
  const error = Object.assign(new Error(privateValue), {
    code: '23505',
    detail: privateValue,
    cause: { url: privateValue },
    receipt: privateValue,
  });
  expect(operationalError(error)).toEqual({ code: 'database_error', sqlState: '23505' });
  expect(JSON.stringify(operationalError(error))).not.toContain(privateValue);
  expect(operationalError({ code: privateValue, message: privateValue })).toEqual({
    code: 'operation_failed',
  });
  expect(operationalError({ code: 'storage_not_configured', message: privateValue })).toEqual({
    code: 'storage_not_configured',
  });
});
