import { describe, expect, it, vi } from 'vitest';
import { EngineError } from '@media-router/engine';
import { workServerOnce } from '../apps/server/src/worker-turn.js';

function fixture(generation: () => Promise<unknown> = async () => false) {
  const calls: string[] = [];
  const workOnce = vi.fn(async () => {
    calls.push('generation');
    return generation();
  });
  const events = {
    workOnce: vi.fn(async () => {
      calls.push('events');
    }),
    scanAlerts: vi.fn(async () => {
      calls.push('alerts');
    }),
  };
  const notificationEmail = {
    workOnce: vi.fn(async () => {
      calls.push('notifications');
    }),
  };
  const billing = {
    workOnce: vi.fn(async () => {
      calls.push('billing');
    }),
  };
  // Only the orchestration's consumed methods are supplied; no database or
  // provider implementation is created by this scheduling regression fixture.
  const engine = { workOnce, events, notificationEmail } as unknown as Parameters<
    typeof workServerOnce
  >[0];
  return { engine, workOnce, events, notificationEmail, billing, calls };
}

describe('worker turn maintenance while generation is scope-gated', () => {
  it('runs every maintenance lane exactly once on repeated transition-gated turns', async () => {
    const f = fixture(async () => {
      throw new EngineError(
        'execution_scope_transition_required',
        'Operator transition needed.',
        503,
      );
    });
    for (let turn = 0; turn < 3; turn++)
      await expect(workServerOnce(f.engine, f.billing)).resolves.toBeUndefined();

    for (const work of [
      f.workOnce,
      f.events.workOnce,
      f.events.scanAlerts,
      f.notificationEmail.workOnce,
      f.billing.workOnce,
    ])
      expect(work).toHaveBeenCalledTimes(3);
    expect(f.calls).toEqual(
      Array.from({ length: 3 }, () => [
        'generation',
        'events',
        'alerts',
        'notifications',
        'billing',
      ]).flat(),
    );
  });

  it('retains the ordinary successful turn without requiring a billing lane', async () => {
    const f = fixture();
    await workServerOnce(f.engine);
    expect(f.calls).toEqual(['generation', 'events', 'alerts', 'notifications']);
  });

  it.each([
    new Error('Unexpected generation error.'),
    new EngineError('database_unavailable', 'Database unavailable.', 503),
    Object.assign(new Error('Not an EngineError.'), {
      code: 'execution_scope_transition_required',
    }),
  ])('propagates unrelated generation errors without starting later lanes: %s', async (error) => {
    const f = fixture(async () => {
      throw error;
    });
    await expect(workServerOnce(f.engine, f.billing)).rejects.toBe(error);
    expect(f.calls).toEqual(['generation']);
  });

  it('does not swallow an identically coded error raised by maintenance itself', async () => {
    const f = fixture();
    const failure = new EngineError(
      'execution_scope_transition_required',
      'Unexpected event error.',
      503,
    );
    f.events.workOnce.mockImplementation(async () => {
      f.calls.push('events');
      throw failure;
    });
    await expect(workServerOnce(f.engine, f.billing)).rejects.toBe(failure);
    expect(f.calls).toEqual(['generation', 'events']);
  });
});
